package com.example.dbviewer;

public final class JdbcDialectTest {
  private JdbcDialectTest() {}

  public static void main(String[] args) {
    assertEquals(JdbcDialect.SQL_SERVER, JdbcDialect.fromProductName("Microsoft SQL Server"));
    assertEquals(JdbcDialect.MYSQL, JdbcDialect.fromProductName("MySQL"));
    assertEquals(JdbcDialect.POSTGRESQL, JdbcDialect.fromProductName("PostgreSQL"));
    assertEquals("[Order]]Detail]", JdbcDialect.SQL_SERVER.quoteIdentifier("Order]Detail", "\""));
    assertEquals(
      "select * from [dbo].[person] order by (select null) offset 10 rows fetch next 101 rows only",
      JdbcDialect.SQL_SERVER.paginatedSql("select * from [dbo].[person]", 10, 101, false)
    );
    assertEquals(
      "select * from person order by id offset 10 rows fetch next 101 rows only",
      JdbcDialect.SQL_SERVER.paginatedSql("select * from person order by id", 10, 101, true)
    );
    assertEquals(
      "select * from person limit 101 offset 10",
      JdbcDialect.MYSQL.paginatedSql("select * from person", 10, 101, false)
    );
    assertEquals(true, JdbcDialect.SQL_SERVER.isGeneratedType("timestamp"));
    assertEquals(true, JdbcDialect.SQL_SERVER.isGeneratedType("rowversion"));
    assertEquals(false, JdbcDialect.POSTGRESQL.isGeneratedType("timestamp"));
    System.out.println("Java JDBC dialect test passed.");
  }

  private static void assertEquals(Object expected, Object actual) {
    if (!expected.equals(actual)) {
      throw new AssertionError("Expected " + expected + " but was " + actual);
    }
  }
}
