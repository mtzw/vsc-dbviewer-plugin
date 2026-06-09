package com.example.dbviewer;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.Statement;

public final class JdbcHelperH2Test {
  private JdbcHelperH2Test() {}

  public static void main(String[] args) throws Exception {
    Class.forName("org.h2.Driver");
    String jdbcUrl = "jdbc:h2:mem:dbviewer;DB_CLOSE_DELAY=-1";
    try (Connection connection = DriverManager.getConnection(jdbcUrl, "sa", "");
         Statement statement = connection.createStatement()) {
      statement.execute("create table department (id integer primary key, name varchar(40) not null unique)");
      statement.execute("create table person (id integer primary key, department_id integer not null, name varchar(40) not null, email varchar(80), constraint uq_person_email unique (email), constraint fk_person_department foreign key (department_id) references department(id))");
      statement.execute("create index ix_person_name on person(name)");
      statement.execute("insert into department (id, name) values (1, 'Engineering')");
      statement.execute("insert into department (id, name) values (2, 'Sales')");
      statement.execute("insert into person (id, department_id, name, email) values (1, 1, 'Alice', 'alice@example.com')");
      statement.execute("insert into person (id, department_id, name, email) values (2, 1, 'Bob', 'bob@example.com')");
      statement.execute("insert into person (id, department_id, name, email) values (3, 1, 'Carol', 'carol@example.com')");
      statement.execute("create table tsv_import (id integer primary key, name varchar(40) not null, note varchar(80))");
      statement.execute("create table tsv_typed_import (id integer primary key, amount decimal(10, 2), active boolean)");
      statement.execute("create view person_view as select id, name from person");
    }

    assertContains(call("testConnection", jdbcUrl, null), "\"connected\":true");
    assertContains(call("listTablesAndViews", jdbcUrl, "{\"schema\":null,\"name\":\"\",\"type\":\"TABLE\"}"), "\"name\":\"PERSON\"");
    String info = call("getObjectInfo", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}");
    assertContains(info, "\"primaryKeys\":[\"ID\"]");
    assertContains(info, "\"constraints\":[");
    assertContains(info, "\"type\":\"PRIMARY KEY\"");
    assertContains(info, "\"type\":\"FOREIGN KEY\"");
    assertContains(info, "\"type\":\"UNIQUE\"");
    assertContains(info, "\"referencedTable\":\"DEPARTMENT\"");
    assertContains(info, "\"indexes\":[");
    assertContains(info, "\"name\":\"IX_PERSON_NAME\"");
    String viewInfo = call("getObjectInfo", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON_VIEW\",\"type\":\"VIEW\"}");
    assertContains(viewInfo, "\"name\":\"PERSON_VIEW\"");
    assertContains(viewInfo, "\"primaryKeys\":[]");
    assertContains(viewInfo, "\"constraints\":[]");
    assertContains(viewInfo, "\"indexes\":[]");
    String data = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(data, "\"Alice\"");
    assertContains(data, "\"columnTypes\":[");
    assertContains(data, "\"jdbcType\":4");
    String filtered = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 100, 0, ",\"where\":\"NAME = 'Alice'\"");
    assertContains(filtered, "\"Alice\"");
    assertNotContains(filtered, "\"Bob\"");
    String sorted = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 100, 0, ",\"sortColumn\":\"NAME\",\"sortDirection\":\"DESC\"");
    assertContains(sorted, "\"rows\":[[3,1,\"Carol\"");
    String paged = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 1, 1);
    assertContains(paged, "\"offset\":1");
    assertContains(paged, "\"hasPrevious\":true");
    assertContains(paged, "\"hasNext\":true");
    assertContains(paged, "\"Bob\"");
    assertContains(call("getObjectDdl", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 100, 0), "CREATE TABLE");
    String inserted = call(
      "insertRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"columns\":[\"ID\",\"NAME\",\"NOTE\"],\"rows\":[[10,\"Dave\",null],[11,\"Eve\",\"\"]]"
    );
    assertContains(inserted, "\"insertedRows\":2");
    String imported = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(imported, "[10,\"Dave\",null]");
    assertContains(imported, "[11,\"Eve\",\"\"]");
    String deleted = call(
      "deleteRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"primaryKeyColumns\":[\"ID\"],\"rows\":[[11]]"
    );
    assertContains(deleted, "\"deletedRows\":1");
    String afterDelete = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertNotContains(afterDelete, "\"Eve\"");
    String updated = call(
      "updateRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"updateColumns\":[\"NAME\",\"NOTE\"],\"primaryKeyColumns\":[\"ID\"],\"rows\":[[\"David\",\"updated\",10]]"
    );
    assertContains(updated, "\"updatedRows\":1");
    String afterUpdate = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(afterUpdate, "[10,\"David\",\"updated\"]");
    String typedInserted = call(
      "insertRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"TSV_TYPED_IMPORT\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"columns\":[\"ID\",\"AMOUNT\",\"ACTIVE\"],\"rows\":[[\"20\",\"123.45\",\"true\"],[\"21\",\"0.50\",\"0\"]]"
    );
    assertContains(typedInserted, "\"insertedRows\":2");
    String typedImported = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"TSV_TYPED_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(typedImported, "[20,123.45,true]");
    assertContains(typedImported, "[21,0.50,false]");
    String failed = callFailure(
      "insertRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}",
      ",\"columns\":[\"ID\",\"NAME\",\"NOTE\"],\"rows\":[[12,\"Frank\",\"ok\"],[10,\"Grace\",\"duplicate\"]]"
    );
    assertContains(failed, "\"ok\":false");
    String afterRollback = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertNotContains(afterRollback, "\"Frank\"");
    String failedDelete = callFailure(
      "deleteRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"DEPARTMENT\",\"type\":\"TABLE\"}",
      ",\"primaryKeyColumns\":[\"ID\"],\"rows\":[[2],[1]]"
    );
    assertContains(failedDelete, "\"ok\":false");
    String departmentsAfterRollback = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"DEPARTMENT\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(departmentsAfterRollback, "[2,\"Sales\"]");
    String failedUpdate = callFailure(
      "updateRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}",
      ",\"updateColumns\":[\"EMAIL\"],\"primaryKeyColumns\":[\"ID\"],\"rows\":[[\"shared@example.com\",2],[\"shared@example.com\",3]]"
    );
    assertContains(failedUpdate, "\"ok\":false");
    String peopleAfterRollback = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(peopleAfterRollback, "[2,1,\"Bob\",\"bob@example.com\"]");
    assertContains(peopleAfterRollback, "[3,1,\"Carol\",\"carol@example.com\"]");
    System.out.println("Java helper H2 integration test passed.");
  }

  private static String call(String action, String jdbcUrl, String objectJson) throws Exception {
    return call(action, jdbcUrl, objectJson, 100, 0);
  }

  private static String call(String action, String jdbcUrl, String objectJson, int limit, int offset) throws Exception {
    return call(action, jdbcUrl, objectJson, limit, offset, "");
  }

  private static String call(String action, String jdbcUrl, String objectJson, int limit, int offset, String extraJson) throws Exception {
    String request = "{"
      + "\"action\":\"" + action + "\","
      + "\"connection\":{"
      + "\"jdbcUrl\":\"" + jdbcUrl + "\","
      + "\"driverClass\":\"org.h2.Driver\","
      + "\"username\":\"sa\","
      + "\"password\":\"\""
      + "}"
      + (objectJson == null ? "" : ",\"object\":" + objectJson + ",\"limit\":" + limit + ",\"offset\":" + offset + extraJson)
      + "}";

    ByteArrayInputStream input = new ByteArrayInputStream(request.getBytes(StandardCharsets.UTF_8));
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    PrintStream originalOut = System.out;
    var originalIn = System.in;
    try {
      System.setIn(input);
      System.setOut(new PrintStream(output, true, StandardCharsets.UTF_8));
      JdbcHelper.main(new String[0]);
    } finally {
      System.setIn(originalIn);
      System.setOut(originalOut);
    }
    String response = output.toString(StandardCharsets.UTF_8);
    assertContains(response, "\"ok\":true");
    return response;
  }

  private static String callFailure(String action, String jdbcUrl, String objectJson, String extraJson) throws Exception {
    String request = "{"
      + "\"action\":\"" + action + "\","
      + "\"connection\":{"
      + "\"jdbcUrl\":\"" + jdbcUrl + "\","
      + "\"driverClass\":\"org.h2.Driver\","
      + "\"username\":\"sa\","
      + "\"password\":\"\""
      + "},"
      + "\"object\":" + objectJson
      + extraJson
      + "}";

    ByteArrayInputStream input = new ByteArrayInputStream(request.getBytes(StandardCharsets.UTF_8));
    ByteArrayOutputStream output = new ByteArrayOutputStream();
    PrintStream originalOut = System.out;
    var originalIn = System.in;
    try {
      System.setIn(input);
      System.setOut(new PrintStream(output, true, StandardCharsets.UTF_8));
      JdbcHelper.main(new String[0]);
    } finally {
      System.setIn(originalIn);
      System.setOut(originalOut);
    }
    return output.toString(StandardCharsets.UTF_8);
  }

  private static void assertContains(String value, String expected) {
    if (!value.contains(expected)) {
      throw new AssertionError("Expected response to contain " + expected + " but was: " + value);
    }
  }

  private static void assertNotContains(String value, String unexpected) {
    if (value.contains(unexpected)) {
      throw new AssertionError("Expected response not to contain " + unexpected + " but was: " + value);
    }
  }
}
