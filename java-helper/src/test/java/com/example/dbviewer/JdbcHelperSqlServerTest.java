package com.example.dbviewer;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.SQLException;
import java.sql.Statement;
import java.time.Duration;
import java.time.Instant;
import java.util.logging.Level;
import java.util.logging.Logger;

public final class JdbcHelperSqlServerTest {
  private static final String SCHEMA = testSchema();
  private static final String DATABASE = "DbViewerTest";

  private JdbcHelperSqlServerTest() {}

  public static void main(String[] args) throws Exception {
    Logger.getLogger("com.microsoft.sqlserver.jdbc").setLevel(Level.OFF);
    String jdbcUrl = requiredEnvironment("MSSQL_JDBC_URL");
    String adminJdbcUrl = environment("MSSQL_ADMIN_JDBC_URL", jdbcUrl);
    String username = environment("MSSQL_USERNAME", "sa");
    String password = requiredEnvironment("MSSQL_PASSWORD");
    boolean createDatabase = Boolean.parseBoolean(environment("MSSQL_CREATE_DATABASE", "false"));

    Class.forName("com.microsoft.sqlserver.jdbc.SQLServerDriver");
    waitForConnection(adminJdbcUrl, username, password);
    if (createDatabase) {
      ensureDatabase(adminJdbcUrl, username, password);
    }
    waitForConnection(jdbcUrl, username, password);

    try {
      createFixture(jdbcUrl, username, password);
      runAssertions(jdbcUrl, username, password);
      System.out.println("Java helper SQL Server integration test passed.");
    } finally {
      dropFixture(jdbcUrl, username, password);
    }
  }

  private static void runAssertions(String jdbcUrl, String username, String password) throws Exception {
    String sample = objectJson("sample", "TABLE");
    assertContains(call("testConnection", jdbcUrl, username, password, null, ""), "\"connected\":true");
    assertContains(call("listSchemas", jdbcUrl, username, password, null, ""), "\"name\":\"" + SCHEMA + "\"");
    assertContains(call("listTablesAndViews", jdbcUrl, username, password, objectJson("", "TABLE"), ""), "\"name\":\"sample\"");
    assertContains(call("listTablesAndViews", jdbcUrl, username, password, objectJson("", "VIEW"), ""), "\"name\":\"sample_view\"");
    assertContains(call("getObjectInfo", jdbcUrl, username, password, objectJson("sample_view", "VIEW"), ""), "\"primaryKeys\":[]");
    assertContains(call("getObjectData", jdbcUrl, username, password, objectJson("sample_view", "VIEW"), ",\"limit\":100,\"offset\":0"), "\"Alice\"");

    String info = call("getObjectInfo", jdbcUrl, username, password, sample, "");
    assertContains(info, "\"primaryKeys\":[\"id\"]");
    assertContains(info, "\"type\":\"FOREIGN KEY\"");
    assertContains(info, "\"type\":\"UNIQUE\"");
    assertContains(info, "\"name\":\"ix_sample_amount\"");
    assertColumnFlag(info, "id", "autoIncrement", true);
    assertColumnFlag(info, "id", "generated", true);
    assertColumnFlag(info, "computed_name", "generated", true);
    assertColumnFlag(info, "row_version", "generated", true);
    assertColumnType(info, "external_id", "uniqueidentifier");
    assertColumnType(info, "observed_at", "datetimeoffset");
    assertColumnType(info, "payload", "varbinary");

    String data = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":100,\"offset\":0");
    assertContains(data, "\"base64:AQKg/w==\"");
    assertContains(data.toLowerCase(), "12345678-1234-1234-1234-1234567890ab");
    assertContains(data, "+09:00");
    assertContains(data, "\"ALICE\"");

    String filtered = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":100,\"offset\":0,\"where\":\"name = N'Alice'\"");
    assertContains(filtered, "\"Alice\"");
    assertNotContains(filtered, "\"Bob\"");
    String sorted = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":100,\"offset\":0,\"sortColumn\":\"name\",\"sortDirection\":\"DESC\"");
    assertContains(sorted, "\"rows\":[[3,");
    String firstPage = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":1,\"offset\":0");
    String secondPage = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":1,\"offset\":1");
    String thirdPage = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":1,\"offset\":2");
    assertContains(firstPage, "\"rows\":[[1,");
    assertContains(secondPage, "\"rows\":[[2,");
    assertContains(thirdPage, "\"rows\":[[3,");
    assertContains(secondPage, "\"hasPrevious\":true");
    assertContains(secondPage, "\"hasNext\":true");

    String ddl = call("getObjectDdl", jdbcUrl, username, password, sample, "");
    assertContains(ddl, "CREATE TABLE");
    assertContains(ddl.toLowerCase(), "datetimeoffset");

    String inserted = call(
      "insertRows",
      jdbcUrl,
      username,
      password,
      sample,
      ",\"columns\":[\"department_id\",\"name\",\"amount\",\"active\",\"created_at\",\"observed_at\",\"payload\"]"
        + ",\"rows\":[[1,\"引用\\tTSV\\nデータ\",\"42.50\",\"true\",\"2026-07-25 12:00:00.1234567\",\"2026-07-25T12:00:00+09:00\",\"base64:ESIz\"]]"
    );
    assertContains(inserted, "\"insertedRows\":1");
    String afterInsert = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":100,\"offset\":0,\"where\":\"id = 4\"");
    assertContains(afterInsert, "引用\\tTSV\\nデータ");
    assertContains(afterInsert, "\"base64:ESIz\"");

    String generatedWriteFailure = callFailure(
      "insertRows",
      jdbcUrl,
      username,
      password,
      sample,
      ",\"columns\":[\"department_id\",\"name\",\"row_version\"],\"rows\":[[1,\"Rejected\",\"base64:AQID\"]]"
    );
    assertContains(generatedWriteFailure, "Insert cannot write generated column: row_version");

    String updated = call(
      "updateRows",
      jdbcUrl,
      username,
      password,
      sample,
      ",\"updateColumns\":[\"name\",\"amount\",\"active\",\"observed_at\",\"payload\"]"
        + ",\"primaryKeyColumns\":[\"id\"]"
        + ",\"rows\":[[\"Updated\",\"99.75\",\"false\",\"2026-07-26T01:02:03+00:00\",\"base64:REVG\",4]]"
    );
    assertContains(updated, "\"updatedRows\":1");

    String mismatchedUpdate = callFailure(
      "updateRows",
      jdbcUrl,
      username,
      password,
      sample,
      ",\"updateColumns\":[\"name\"],\"primaryKeyColumns\":[\"id\"],\"rows\":[[\"RolledBack\",4],[\"Missing\",999]]"
    );
    assertContains(mismatchedUpdate, "Update affected 1 row(s), expected 2. The transaction was rolled back.");
    String afterUpdateRollback = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":100,\"offset\":0,\"where\":\"id = 4\"");
    assertContains(afterUpdateRollback, "\"Updated\"");
    assertNotContains(afterUpdateRollback, "\"RolledBack\"");

    String batchFailure = callFailure(
      "insertRows",
      jdbcUrl,
      username,
      password,
      sample,
      ",\"columns\":[\"department_id\",\"name\",\"amount\",\"active\",\"created_at\"]"
        + ",\"rows\":[[1,\"BatchOne\",\"1.00\",\"true\",\"2026-07-27 00:00:00\"],[1,\"Alice\",\"2.00\",\"true\",\"2026-07-27 00:00:00\"]]"
    );
    assertContains(batchFailure, "\"ok\":false");
    String afterBatchRollback = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":100,\"offset\":0,\"where\":\"name = N'BatchOne'\"");
    assertContains(afterBatchRollback, "\"rows\":[]");

    String mismatchedDelete = callFailure(
      "deleteRows",
      jdbcUrl,
      username,
      password,
      sample,
      ",\"primaryKeyColumns\":[\"id\"],\"rows\":[[4],[999]]"
    );
    assertContains(mismatchedDelete, "Delete affected 1 row(s), expected 2. The transaction was rolled back.");
    String afterDeleteRollback = call("getObjectData", jdbcUrl, username, password, sample, ",\"limit\":100,\"offset\":0,\"where\":\"id = 4\"");
    assertContains(afterDeleteRollback, "\"Updated\"");

    String deleted = call(
      "deleteRows",
      jdbcUrl,
      username,
      password,
      sample,
      ",\"primaryKeyColumns\":[\"id\"],\"rows\":[[4]]"
    );
    assertContains(deleted, "\"deletedRows\":1");
  }

  private static void createFixture(String jdbcUrl, String username, String password) throws SQLException {
    try (Connection connection = DriverManager.getConnection(jdbcUrl, username, password);
         Statement statement = connection.createStatement()) {
      dropFixture(statement);
      statement.execute("create schema " + SCHEMA);
      statement.execute("create table " + SCHEMA + ".department (id int primary key, name nvarchar(80) not null, constraint uq_department_name unique (name))");
      statement.execute("create table " + SCHEMA + ".sample ("
        + "id int identity(1,1) primary key,"
        + "department_id int not null,"
        + "external_id uniqueidentifier not null default newid(),"
        + "name nvarchar(100) not null,"
        + "amount money null,"
        + "active bit not null,"
        + "created_at datetime2(7) not null,"
        + "observed_at datetimeoffset(7) null,"
        + "payload varbinary(max) null,"
        + "computed_name as upper(name),"
        + "row_version rowversion,"
        + "constraint fk_sample_department foreign key (department_id) references " + SCHEMA + ".department(id),"
        + "constraint uq_sample_name unique (name),"
        + "constraint uq_sample_external_id unique (external_id)"
        + ")");
      statement.execute("create index ix_sample_amount on " + SCHEMA + ".sample(amount)");
      statement.execute("insert into " + SCHEMA + ".department (id, name) values (1, N'Engineering'), (2, N'Sales')");
      statement.execute("insert into " + SCHEMA + ".sample (department_id, external_id, name, amount, active, created_at, observed_at, payload) values "
        + "(1, '12345678-1234-1234-1234-1234567890ab', N'Alice', 10.25, 1, '2026-07-22T10:20:30.1234567', '2026-07-22T10:20:30+09:00', 0x0102A0FF),"
        + "(1, '22345678-1234-1234-1234-1234567890ab', N'Bob', 20.50, 0, '2026-07-23T11:21:31.1234567', '2026-07-23T11:21:31+00:00', 0xCAFE),"
        + "(2, '32345678-1234-1234-1234-1234567890ab', N'Carol', 30.75, 1, '2026-07-24T12:22:32.1234567', null, null)");
      statement.execute("create view " + SCHEMA + ".sample_view as select id, name, computed_name from " + SCHEMA + ".sample");
    }
  }

  private static void dropFixture(String jdbcUrl, String username, String password) {
    try (Connection connection = DriverManager.getConnection(jdbcUrl, username, password);
         Statement statement = connection.createStatement()) {
      dropFixture(statement);
    } catch (SQLException ignored) {
      // The managed test container is removed after the test; cleanup is best effort.
    }
  }

  private static void dropFixture(Statement statement) throws SQLException {
    statement.execute("if object_id('" + SCHEMA + ".sample_view', 'V') is not null drop view " + SCHEMA + ".sample_view");
    statement.execute("if object_id('" + SCHEMA + ".sample', 'U') is not null drop table " + SCHEMA + ".sample");
    statement.execute("if object_id('" + SCHEMA + ".department', 'U') is not null drop table " + SCHEMA + ".department");
    statement.execute("if schema_id('" + SCHEMA + "') is not null exec('drop schema " + SCHEMA + "')");
  }

  private static void ensureDatabase(String adminJdbcUrl, String username, String password) throws SQLException {
    try (Connection connection = DriverManager.getConnection(adminJdbcUrl, username, password);
         Statement statement = connection.createStatement()) {
      statement.execute("if db_id('" + DATABASE + "') is null create database [" + DATABASE + "]");
    }
  }

  private static void waitForConnection(String jdbcUrl, String username, String password) throws Exception {
    Instant deadline = Instant.now().plus(Duration.ofMinutes(3));
    SQLException lastError = null;
    while (Instant.now().isBefore(deadline)) {
      try (Connection ignored = DriverManager.getConnection(jdbcUrl, username, password)) {
        return;
      } catch (SQLException error) {
        lastError = error;
        Thread.sleep(2_000);
      }
    }
    throw new SQLException("SQL Server did not become ready within 3 minutes.", lastError);
  }

  private static String call(
    String action,
    String jdbcUrl,
    String username,
    String password,
    String objectJson,
    String extraJson
  ) throws Exception {
    String response = invoke(action, jdbcUrl, username, password, objectJson, extraJson);
    assertContains(response, "\"ok\":true");
    return response;
  }

  private static String callFailure(
    String action,
    String jdbcUrl,
    String username,
    String password,
    String objectJson,
    String extraJson
  ) throws Exception {
    String response = invoke(action, jdbcUrl, username, password, objectJson, extraJson);
    assertContains(response, "\"ok\":false");
    return response;
  }

  private static String invoke(
    String action,
    String jdbcUrl,
    String username,
    String password,
    String objectJson,
    String extraJson
  ) throws Exception {
    String request = "{"
      + "\"action\":\"" + action + "\","
      + "\"connection\":{"
      + "\"jdbcUrl\":\"" + escapeJson(jdbcUrl) + "\","
      + "\"driverClass\":\"com.microsoft.sqlserver.jdbc.SQLServerDriver\","
      + "\"username\":\"" + escapeJson(username) + "\","
      + "\"password\":\"" + escapeJson(password) + "\""
      + "}"
      + (objectJson == null ? "" : ",\"object\":" + objectJson)
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

  private static String objectJson(String name, String type) {
    return "{\"schema\":\"" + SCHEMA + "\",\"name\":\"" + name + "\",\"type\":\"" + type + "\"}";
  }

  private static void assertColumnFlag(String response, String column, String flag, boolean expected) {
    String marker = "\"name\":\"" + column + "\"";
    int start = response.indexOf(marker);
    int end = response.indexOf('}', start);
    if (start < 0 || end < 0 || !response.substring(start, end).contains("\"" + flag + "\":" + expected)) {
      throw new AssertionError("Expected column " + column + " to have " + flag + "=" + expected + " but was: " + response);
    }
  }

  private static void assertColumnType(String response, String column, String typeName) {
    String marker = "\"name\":\"" + column + "\"";
    int start = response.indexOf(marker);
    int end = response.indexOf('}', start);
    if (start < 0 || end < 0 || !response.substring(start, end).toLowerCase().contains("\"typename\":\"" + typeName.toLowerCase() + "\"")) {
      throw new AssertionError("Expected column " + column + " to have type " + typeName + " but was: " + response);
    }
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

  private static String requiredEnvironment(String name) {
    String value = System.getenv(name);
    if (value == null || value.isBlank()) {
      throw new IllegalArgumentException(name + " is required.");
    }
    return value;
  }

  private static String testSchema() {
    String schema = environment("MSSQL_TEST_SCHEMA", "dbviewer_it");
    if (!schema.matches("[A-Za-z][A-Za-z0-9_]{0,63}")) {
      throw new IllegalArgumentException("MSSQL_TEST_SCHEMA must contain only letters, digits, and underscores.");
    }
    return schema;
  }

  private static String environment(String name, String defaultValue) {
    String value = System.getenv(name);
    return value == null || value.isBlank() ? defaultValue : value;
  }

  private static String escapeJson(String value) {
    return value.replace("\\", "\\\\").replace("\"", "\\\"");
  }
}
