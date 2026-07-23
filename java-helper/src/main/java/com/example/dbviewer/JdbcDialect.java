package com.example.dbviewer;

import java.sql.Connection;
import java.sql.SQLException;

enum JdbcDialect {
  SQL_SERVER,
  MYSQL,
  ORACLE,
  POSTGRESQL,
  H2,
  STANDARD;

  static JdbcDialect from(Connection connection) throws SQLException {
    return fromProductName(connection.getMetaData().getDatabaseProductName());
  }

  static JdbcDialect fromProductName(String productName) {
    String normalized = productName == null ? "" : productName.trim().toLowerCase();
    if (normalized.contains("microsoft sql server")) {
      return SQL_SERVER;
    }
    if (normalized.contains("mysql") || normalized.contains("mariadb")) {
      return MYSQL;
    }
    if (normalized.contains("oracle")) {
      return ORACLE;
    }
    if (normalized.contains("postgresql")) {
      return POSTGRESQL;
    }
    if (normalized.equals("h2")) {
      return H2;
    }
    return STANDARD;
  }

  String quoteIdentifier(String identifier, String metadataQuote) {
    if (this == SQL_SERVER) {
      return "[" + identifier.replace("]", "]]") + "]";
    }
    if (metadataQuote == null || metadataQuote.isBlank()) {
      return identifier;
    }
    return metadataQuote + identifier.replace(metadataQuote, metadataQuote + metadataQuote) + metadataQuote;
  }

  String paginatedSql(String baseSql, int offset, int fetchRows, boolean hasOrderBy) {
    if (this == MYSQL) {
      return baseSql + " limit " + fetchRows + " offset " + offset;
    }
    if (this == SQL_SERVER && !hasOrderBy) {
      return baseSql + " order by (select null) offset " + offset + " rows fetch next " + fetchRows + " rows only";
    }
    return baseSql + " offset " + offset + " rows fetch next " + fetchRows + " rows only";
  }

  boolean isGeneratedType(String typeName) {
    String normalized = typeName == null ? "" : typeName.trim().toLowerCase();
    return normalized.equals("rowversion") || (this == SQL_SERVER && normalized.equals("timestamp"));
  }
}
