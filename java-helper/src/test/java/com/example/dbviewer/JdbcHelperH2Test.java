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
      statement.execute("create table person (id integer primary key, name varchar(40) not null)");
      statement.execute("insert into person (id, name) values (1, 'Alice')");
      statement.execute("insert into person (id, name) values (2, 'Bob')");
      statement.execute("insert into person (id, name) values (3, 'Carol')");
      statement.execute("create view person_view as select id, name from person");
    }

    assertContains(call("testConnection", jdbcUrl, null), "\"connected\":true");
    assertContains(call("listTablesAndViews", jdbcUrl, "{\"schema\":null,\"name\":\"\",\"type\":\"TABLE\"}"), "\"name\":\"PERSON\"");
    assertContains(call("getObjectInfo", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}"), "\"primaryKeys\":[\"ID\"]");
    assertContains(call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 100, 0), "\"Alice\"");
    String paged = call("getObjectData", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 1, 1);
    assertContains(paged, "\"offset\":1");
    assertContains(paged, "\"hasPrevious\":true");
    assertContains(paged, "\"hasNext\":true");
    assertContains(paged, "\"Bob\"");
    assertContains(call("getObjectDdl", jdbcUrl, "{\"schema\":null,\"name\":\"PERSON\",\"type\":\"TABLE\"}", 100, 0), "CREATE TABLE");
    System.out.println("Java helper H2 integration test passed.");
  }

  private static String call(String action, String jdbcUrl, String objectJson) throws Exception {
    return call(action, jdbcUrl, objectJson, 100, 0);
  }

  private static String call(String action, String jdbcUrl, String objectJson, int limit, int offset) throws Exception {
    String request = "{"
      + "\"action\":\"" + action + "\","
      + "\"connection\":{"
      + "\"jdbcUrl\":\"" + jdbcUrl + "\","
      + "\"driverClass\":\"org.h2.Driver\","
      + "\"username\":\"sa\","
      + "\"password\":\"\""
      + "}"
      + (objectJson == null ? "" : ",\"object\":" + objectJson + ",\"limit\":" + limit + ",\"offset\":" + offset)
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

  private static void assertContains(String value, String expected) {
    if (!value.contains(expected)) {
      throw new AssertionError("Expected response to contain " + expected + " but was: " + value);
    }
  }
}
