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
      statement.execute("create table dated_import (id integer primary key, business_date date not null)");
      statement.execute("create table stable_paging (id integer primary key, name varchar(40))");
      statement.execute("insert into stable_paging (id, name) values (3, 'Carol'), (1, 'Alice'), (2, 'Bob')");
      statement.execute("create table unique_paging (code varchar(10) not null unique, name varchar(40))");
      statement.execute("insert into unique_paging (code, name) values ('C', 'Carol'), ('A', 'Alice'), ('B', 'Bob')");
      statement.execute("create table generated_data (key_id integer primary key, generated_id bigint auto_increment, name varchar(40))");
      statement.execute("create table binary_data (id integer primary key, payload varbinary(4), item_uuid uuid, notes clob, attachment blob)");
      statement.execute("insert into binary_data (id, payload, item_uuid, notes, attachment) values (1, X'0102A0FF', '12345678-1234-1234-1234-1234567890ab', 'hello', X'CAFE')");
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
    assertContains(info, "\"autoIncrement\":false");
    assertContains(info, "\"generated\":false");
    String generatedInfo = call("getObjectInfo", jdbcUrl, "{\"schema\":null,\"name\":\"GENERATED_DATA\",\"type\":\"TABLE\"}");
    assertContains(generatedInfo, "\"name\":\"GENERATED_ID\"");
    assertContains(generatedInfo, "\"autoIncrement\":true");
    assertContains(generatedInfo, "\"generated\":true");
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
    String stablePaged = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"STABLE_PAGING\",\"type\":\"TABLE\"}", 1, 1);
    assertContains(stablePaged, "\"rows\":[[2,\"Bob\"]]");
    String uniquePaged = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"UNIQUE_PAGING\",\"type\":\"TABLE\"}", 1, 1);
    assertContains(uniquePaged, "\"rows\":[[\"B\",\"Bob\"]]");
    String binaryData = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"BINARY_DATA\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(binaryData, "\"base64:AQKg/w==\"");
    assertContains(binaryData, "\"12345678-1234-1234-1234-1234567890ab\"");
    assertContains(binaryData, "\"hello\"");
    assertContains(binaryData, "\"base64:yv4=\"");
    assertNotContains(binaryData, "[B@");
    String binaryInserted = call(
      "insertRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"BINARY_DATA\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"columns\":[\"ID\",\"PAYLOAD\",\"NOTES\"],\"rows\":[[2,\"base64:ESIz\",\"inserted\"]]"
    );
    assertContains(binaryInserted, "\"insertedRows\":1");
    String binaryAfterInsert = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"BINARY_DATA\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(binaryAfterInsert, "[2,\"base64:ESIz\"");
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
    String generatedInserted = call(
      "insertRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"GENERATED_DATA\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"columns\":[\"KEY_ID\",\"NAME\"],\"rows\":[[1,\"Generated\"]]"
    );
    assertContains(generatedInserted, "\"insertedRows\":1");
    String generatedWriteFailure = callFailure(
      "insertRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"GENERATED_DATA\",\"type\":\"TABLE\"}",
      ",\"columns\":[\"KEY_ID\",\"GENERATED_ID\",\"NAME\"],\"rows\":[[2,100,\"Rejected\"]]"
    );
    assertContains(generatedWriteFailure, "Insert cannot write generated column: GENERATED_ID");
    String generatedUpdateFailure = callFailure(
      "updateRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"GENERATED_DATA\",\"type\":\"TABLE\"}",
      ",\"updateColumns\":[\"GENERATED_ID\"],\"primaryKeyColumns\":[\"KEY_ID\"],\"rows\":[[100,1]]"
    );
    assertContains(generatedUpdateFailure, "Update cannot write generated column: GENERATED_ID");
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
    String dateInserted = call(
      "insertRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"DATED_IMPORT\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"columns\":[\"ID\",\"BUSINESS_DATE\"],\"rows\":[[\"30\",\"2026-06-09\"]]"
    );
    assertContains(dateInserted, "\"insertedRows\":1");
    String dateUpdated = call(
      "updateRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"DATED_IMPORT\",\"type\":\"TABLE\"}",
      100,
      0,
      ",\"updateColumns\":[\"BUSINESS_DATE\"],\"primaryKeyColumns\":[\"ID\"],\"rows\":[[\"2026-06-10\",30]]"
    );
    assertContains(dateUpdated, "\"updatedRows\":1");
    String dateImported = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"DATED_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(dateImported, "[30,\"2026-06-10\"]");
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
    String mismatchedDelete = callFailure(
      "deleteRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}",
      ",\"primaryKeyColumns\":[\"ID\"],\"rows\":[[10],[999]]"
    );
    assertContains(mismatchedDelete, "Delete affected 1 row(s), expected 2. The transaction was rolled back.");
    String afterMismatchedDelete = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(afterMismatchedDelete, "[10,\"David\",\"updated\"]");
    String mismatchedUpdate = callFailure(
      "updateRows",
      jdbcUrl,
      "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}",
      ",\"updateColumns\":[\"NAME\"],\"primaryKeyColumns\":[\"ID\"],\"rows\":[[\"Changed\",10],[\"Missing\",999]]"
    );
    assertContains(mismatchedUpdate, "Update affected 1 row(s), expected 2. The transaction was rolled back.");
    String afterMismatchedUpdate = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"TSV_IMPORT\",\"type\":\"TABLE\"}", 100, 0);
    assertContains(afterMismatchedUpdate, "[10,\"David\",\"updated\"]");
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
