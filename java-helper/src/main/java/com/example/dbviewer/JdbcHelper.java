package com.example.dbviewer;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

public final class JdbcHelper {
  private JdbcHelper() {}

  public static void main(String[] args) {
    try {
      String input = readAll();
      Object parsed = Json.parse(input);
      if (!(parsed instanceof Map<?, ?> request)) {
        throw new IllegalArgumentException("Request must be a JSON object.");
      }
      Object result = handle(castMap(request));
      writeResponse(true, result, null);
    } catch (Throwable error) {
      writeResponse(false, null, error.getMessage());
    }
  }

  private static Object handle(Map<String, Object> request) throws Exception {
    String action = string(request.get("action"));
    Map<String, Object> connectionConfig = castMap((Map<?, ?>) request.get("connection"));
    Class.forName(string(connectionConfig.get("driverClass")));

    Properties properties = new Properties();
    String username = string(connectionConfig.get("username"));
    String password = string(connectionConfig.get("password"));
    if (!username.isEmpty()) {
      properties.setProperty("user", username);
    }
    if (!password.isEmpty()) {
      properties.setProperty("password", password);
    }

    try (Connection connection = DriverManager.getConnection(string(connectionConfig.get("jdbcUrl")), properties)) {
      return switch (action) {
        case "testConnection" -> Map.of("connected", true);
        case "listSchemas" -> listSchemas(connection);
        case "listTablesAndViews" -> listTablesAndViews(connection, objectSchema(request), objectType(request));
        case "getObjectInfo" -> getObjectInfo(connection, object(request));
        case "getObjectData" -> getObjectData(connection, object(request), intValue(request.get("limit"), 100), intValue(request.get("offset"), 0));
        case "getObjectDdl" -> getObjectDdl(connection, object(request));
        default -> throw new IllegalArgumentException("Unknown action: " + action);
      };
    }
  }

  private static List<Map<String, Object>> listSchemas(Connection connection) throws SQLException {
    DatabaseMetaData metadata = connection.getMetaData();
    List<Map<String, Object>> schemas = new ArrayList<>();
    try (ResultSet rs = metadata.getSchemas()) {
      while (rs.next()) {
        String name = rs.getString("TABLE_SCHEM");
        if (name != null && !isSystemSchema(name)) {
          schemas.add(Map.of("name", name));
        }
      }
    }
    schemas.sort(Comparator.comparing(row -> String.valueOf(row.get("name"))));
    return schemas;
  }

  private static List<Map<String, Object>> listTablesAndViews(Connection connection, String schema, String requestedType) throws SQLException {
    DatabaseMetaData metadata = connection.getMetaData();
    List<Map<String, Object>> objects = new ArrayList<>();
    String schemaPattern = emptyToNull(schema);
    if (schemaPattern == null) {
      schemaPattern = currentSchema(connection);
    }
    String tableType = "VIEW".equalsIgnoreCase(requestedType) ? "VIEW" : "TABLE";
    try (ResultSet rs = metadata.getTables(connection.getCatalog(), schemaPattern, "%", new String[] {tableType})) {
      while (rs.next()) {
        String actualType = "VIEW".equalsIgnoreCase(rs.getString("TABLE_TYPE")) ? "VIEW" : "TABLE";
        if (!tableType.equals(actualType)) {
          continue;
        }
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("schema", rs.getString("TABLE_SCHEM"));
        row.put("name", rs.getString("TABLE_NAME"));
        row.put("type", actualType);
        objects.add(row);
      }
    }
    objects.sort(Comparator.comparing(row -> String.valueOf(row.get("name"))));
    return objects;
  }

  private static Map<String, Object> getObjectInfo(Connection connection, DbObject object) throws SQLException {
    DatabaseMetaData metadata = connection.getMetaData();
    List<Map<String, Object>> columns = new ArrayList<>();
    try (ResultSet rs = metadata.getColumns(null, object.schema(), object.name(), "%")) {
      while (rs.next()) {
        Map<String, Object> column = new LinkedHashMap<>();
        column.put("name", rs.getString("COLUMN_NAME"));
        column.put("typeName", rs.getString("TYPE_NAME"));
        int size = rs.getInt("COLUMN_SIZE");
        column.put("size", rs.wasNull() ? null : size);
        column.put("nullable", rs.getInt("NULLABLE") == DatabaseMetaData.columnNullable);
        column.put("ordinal", rs.getInt("ORDINAL_POSITION"));
        column.put("defaultValue", rs.getString("COLUMN_DEF"));
        column.put("remarks", rs.getString("REMARKS"));
        columns.add(column);
      }
    }
    columns.sort(Comparator.comparingInt(row -> ((Number) row.get("ordinal")).intValue()));

    List<String> primaryKeys = new ArrayList<>();
    try (ResultSet rs = metadata.getPrimaryKeys(null, object.schema(), object.name())) {
      while (rs.next()) {
        primaryKeys.add(rs.getString("COLUMN_NAME"));
      }
    }

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("schema", object.schema());
    result.put("name", object.name());
    result.put("type", object.type());
    result.put("columns", columns);
    result.put("primaryKeys", primaryKeys);
    result.put("identifierQuoteString", normalizedIdentifierQuote(connection));
    return result;
  }

  private static Map<String, Object> getObjectData(Connection connection, DbObject object, int limit, int offset) throws SQLException {
    int safeLimit = Math.max(1, Math.min(limit, 1000));
    int safeOffset = Math.max(0, offset);
    String sql = "select * from " + qualifiedName(connection, object) + " offset " + safeOffset + " rows fetch next " + (safeLimit + 1) + " rows only";
    try (Statement statement = connection.createStatement()) {
      try {
        return readRows(statement, sql, safeLimit, safeOffset, 0);
      } catch (SQLException firstError) {
        String fallbackSql = "select * from " + qualifiedName(connection, object);
        statement.setMaxRows(safeLimit + safeOffset + 1);
        return readRows(statement, fallbackSql, safeLimit, safeOffset, safeOffset);
      }
    }
  }

  private static Map<String, Object> readRows(Statement statement, String sql, int limit, int offset, int rowsToSkip) throws SQLException {
    try (ResultSet rs = statement.executeQuery(sql)) {
      ResultSetMetaData metadata = rs.getMetaData();
      List<String> columns = new ArrayList<>();
      for (int i = 1; i <= metadata.getColumnCount(); i += 1) {
        columns.add(metadata.getColumnLabel(i));
      }
      List<List<Object>> rows = new ArrayList<>();
      int skipped = 0;
      while (skipped < rowsToSkip && rs.next()) {
        skipped += 1;
      }
      while (rs.next()) {
        List<Object> row = new ArrayList<>();
        for (int i = 1; i <= metadata.getColumnCount(); i += 1) {
          row.add(rs.getObject(i));
        }
        rows.add(row);
        if (rows.size() > limit) {
          break;
        }
      }
      boolean hasNext = rows.size() > limit;
      if (hasNext) {
        rows.remove(rows.size() - 1);
      }
      Map<String, Object> result = new LinkedHashMap<>();
      result.put("columns", columns);
      result.put("rows", rows);
      result.put("limit", limit);
      result.put("offset", offset);
      result.put("hasPrevious", offset > 0);
      result.put("hasNext", hasNext);
      return result;
    }
  }

  private static Map<String, Object> getObjectDdl(Connection connection, DbObject object) throws SQLException {
    Map<String, Object> result = new LinkedHashMap<>();
    if ("VIEW".equalsIgnoreCase(object.type())) {
      result.put("ddl", null);
      result.put("message", "View definition SQL is not available through generic JDBC metadata.");
      return result;
    }

    ObjectInfoParts parts = objectInfoParts(connection, object);
    if (parts.columns().isEmpty()) {
      result.put("ddl", null);
      result.put("message", "DDL is not available because column metadata could not be read.");
      return result;
    }

    StringBuilder ddl = new StringBuilder();
    ddl.append("CREATE ").append(object.type()).append(" ").append(qualifiedName(connection, object)).append(" (\n");
    for (int i = 0; i < parts.columns().size(); i += 1) {
      Map<String, Object> column = parts.columns().get(i);
      ddl.append("  ").append(quote(connection, string(column.get("name")))).append(" ").append(string(column.get("typeName")));
      Object size = column.get("size");
      if (size instanceof Number number && number.intValue() > 0 && shouldShowSize(string(column.get("typeName")))) {
        ddl.append("(").append(number.intValue()).append(")");
      }
      if (Boolean.FALSE.equals(column.get("nullable"))) {
        ddl.append(" NOT NULL");
      }
      if (i < parts.columns().size() - 1 || !parts.primaryKeys().isEmpty()) {
        ddl.append(",");
      }
      ddl.append("\n");
    }
    if (!parts.primaryKeys().isEmpty()) {
      ddl.append("  PRIMARY KEY (");
      for (int i = 0; i < parts.primaryKeys().size(); i += 1) {
        if (i > 0) {
          ddl.append(", ");
        }
        ddl.append(quote(connection, parts.primaryKeys().get(i)));
      }
      ddl.append(")\n");
    }
    ddl.append(");");
    result.put("ddl", ddl.toString());
    result.put("message", null);
    return result;
  }

  private static ObjectInfoParts objectInfoParts(Connection connection, DbObject object) throws SQLException {
    Map<String, Object> info = getObjectInfo(connection, object);
    @SuppressWarnings("unchecked")
    List<Map<String, Object>> columns = (List<Map<String, Object>>) info.get("columns");
    @SuppressWarnings("unchecked")
    List<String> primaryKeys = (List<String>) info.get("primaryKeys");
    return new ObjectInfoParts(columns, primaryKeys);
  }

  private static String qualifiedName(Connection connection, DbObject object) throws SQLException {
    if (object.schema() == null || object.schema().isBlank()) {
      return quote(connection, object.name());
    }
    return quote(connection, object.schema()) + "." + quote(connection, object.name());
  }

  private static String quote(Connection connection, String identifier) throws SQLException {
    String quote = normalizedIdentifierQuote(connection);
    if (quote.isBlank()) {
      return identifier;
    }
    return quote + identifier.replace(quote, quote + quote) + quote;
  }

  private static String normalizedIdentifierQuote(Connection connection) throws SQLException {
    String quote = connection.getMetaData().getIdentifierQuoteString();
    return quote == null || quote.isBlank() ? "" : quote;
  }

  private static boolean shouldShowSize(String typeName) {
    String type = typeName.toLowerCase();
    return type.contains("char") || type.contains("binary") || type.equals("decimal") || type.equals("numeric");
  }

  private static String objectSchema(Map<String, Object> request) {
    Object raw = request.get("object");
    if (!(raw instanceof Map<?, ?> map)) {
      return null;
    }
    Object schema = map.get("schema");
    return schema == null ? null : String.valueOf(schema);
  }

  private static String objectType(Map<String, Object> request) {
    Object raw = request.get("object");
    if (!(raw instanceof Map<?, ?> map)) {
      return "TABLE";
    }
    Object type = map.get("type");
    return type == null ? "TABLE" : String.valueOf(type);
  }

  private static String currentSchema(Connection connection) throws SQLException {
    try {
      String schema = connection.getSchema();
      if (schema != null && !schema.isBlank()) {
        return schema;
      }
    } catch (Exception ignored) {
      // Some older JDBC drivers do not implement getSchema().
    }

    String userName = connection.getMetaData().getUserName();
    if (userName == null || userName.isBlank()) {
      return null;
    }
    int slash = userName.indexOf('/');
    String schema = slash >= 0 ? userName.substring(0, slash) : userName;
    int at = schema.indexOf('@');
    if (at >= 0) {
      schema = schema.substring(0, at);
    }
    return schema.isBlank() ? null : schema;
  }

  private static DbObject object(Map<String, Object> request) {
    Object raw = request.get("object");
    if (!(raw instanceof Map<?, ?> map)) {
      throw new IllegalArgumentException("object is required.");
    }
    return new DbObject(
      nullableString(map.get("schema")),
      string(map.get("name")),
      string(map.get("type"))
    );
  }

  private static String readAll() throws Exception {
    StringBuilder input = new StringBuilder();
    try (BufferedReader reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        input.append(line);
      }
    }
    return input.toString();
  }

  private static void writeResponse(boolean ok, Object result, String error) {
    Map<String, Object> response = new LinkedHashMap<>();
    response.put("ok", ok);
    if (ok) {
      response.put("result", result);
    } else {
      response.put("error", error == null ? "Unknown error" : error);
    }
    try (PrintWriter writer = new PrintWriter(System.out, true, StandardCharsets.UTF_8)) {
      writer.print(Json.stringify(response));
    }
  }

  private static Map<String, Object> castMap(Map<?, ?> map) {
    Map<String, Object> result = new LinkedHashMap<>();
    for (Map.Entry<?, ?> entry : map.entrySet()) {
      result.put(String.valueOf(entry.getKey()), entry.getValue());
    }
    return result;
  }

  private static String string(Object value) {
    return value == null ? "" : String.valueOf(value);
  }

  private static String nullableString(Object value) {
    return value == null ? null : String.valueOf(value);
  }

  private static String emptyToNull(String value) {
    return value == null || value.isBlank() ? null : value;
  }

  private static int intValue(Object value, int defaultValue) {
    return value instanceof Number number ? number.intValue() : defaultValue;
  }

  private static boolean isSystemSchema(String schema) {
    String name = schema.toUpperCase();
    return name.equals("INFORMATION_SCHEMA") || name.equals("PG_CATALOG") || name.startsWith("SYS");
  }

  private record DbObject(String schema, String name, String type) {}

  private record ObjectInfoParts(List<Map<String, Object>> columns, List<String> primaryKeys) {}

  private static final class Json {
    private final String source;
    private int index;

    private Json(String source) {
      this.source = source;
    }

    static Object parse(String source) {
      Json parser = new Json(source);
      Object value = parser.value();
      parser.skipWhitespace();
      if (parser.index != parser.source.length()) {
        throw new IllegalArgumentException("Unexpected trailing JSON content.");
      }
      return value;
    }

    static String stringify(Object value) {
      StringBuilder builder = new StringBuilder();
      writeJson(builder, value);
      return builder.toString();
    }

    private Object value() {
      skipWhitespace();
      if (index >= source.length()) {
        throw new IllegalArgumentException("Unexpected end of JSON.");
      }
      char current = source.charAt(index);
      return switch (current) {
        case '{' -> object();
        case '[' -> array();
        case '"' -> string();
        case 't' -> literal("true", Boolean.TRUE);
        case 'f' -> literal("false", Boolean.FALSE);
        case 'n' -> literal("null", null);
        default -> number();
      };
    }

    private Map<String, Object> object() {
      expect('{');
      Map<String, Object> map = new LinkedHashMap<>();
      skipWhitespace();
      if (peek('}')) {
        index += 1;
        return map;
      }
      while (true) {
        String key = string();
        skipWhitespace();
        expect(':');
        map.put(key, value());
        skipWhitespace();
        if (peek('}')) {
          index += 1;
          return map;
        }
        expect(',');
      }
    }

    private List<Object> array() {
      expect('[');
      List<Object> list = new ArrayList<>();
      skipWhitespace();
      if (peek(']')) {
        index += 1;
        return list;
      }
      while (true) {
        list.add(value());
        skipWhitespace();
        if (peek(']')) {
          index += 1;
          return list;
        }
        expect(',');
      }
    }

    private String string() {
      expect('"');
      StringBuilder builder = new StringBuilder();
      while (index < source.length()) {
        char current = source.charAt(index++);
        if (current == '"') {
          return builder.toString();
        }
        if (current == '\\') {
          char escaped = source.charAt(index++);
          switch (escaped) {
            case '"' -> builder.append('"');
            case '\\' -> builder.append('\\');
            case '/' -> builder.append('/');
            case 'b' -> builder.append('\b');
            case 'f' -> builder.append('\f');
            case 'n' -> builder.append('\n');
            case 'r' -> builder.append('\r');
            case 't' -> builder.append('\t');
            case 'u' -> {
              String hex = source.substring(index, index + 4);
              builder.append((char) Integer.parseInt(hex, 16));
              index += 4;
            }
            default -> throw new IllegalArgumentException("Invalid JSON escape: " + escaped);
          }
        } else {
          builder.append(current);
        }
      }
      throw new IllegalArgumentException("Unterminated JSON string.");
    }

    private Object number() {
      int start = index;
      while (index < source.length()) {
        char current = source.charAt(index);
        if ((current >= '0' && current <= '9') || current == '-' || current == '+' || current == '.' || current == 'e' || current == 'E') {
          index += 1;
        } else {
          break;
        }
      }
      String raw = source.substring(start, index);
      if (raw.contains(".") || raw.contains("e") || raw.contains("E")) {
        return Double.parseDouble(raw);
      }
      return Long.parseLong(raw);
    }

    private Object literal(String literal, Object value) {
      if (!source.startsWith(literal, index)) {
        throw new IllegalArgumentException("Expected JSON literal: " + literal);
      }
      index += literal.length();
      return value;
    }

    private void expect(char expected) {
      skipWhitespace();
      if (index >= source.length() || source.charAt(index) != expected) {
        throw new IllegalArgumentException("Expected JSON character: " + expected);
      }
      index += 1;
    }

    private boolean peek(char expected) {
      return index < source.length() && source.charAt(index) == expected;
    }

    private void skipWhitespace() {
      while (index < source.length() && Character.isWhitespace(source.charAt(index))) {
        index += 1;
      }
    }

    private static void writeJson(StringBuilder builder, Object value) {
      if (value == null) {
        builder.append("null");
      } else if (value instanceof String string) {
        writeString(builder, string);
      } else if (value instanceof Number || value instanceof Boolean) {
        builder.append(value);
      } else if (value instanceof Map<?, ?> map) {
        builder.append('{');
        boolean first = true;
        for (Map.Entry<?, ?> entry : map.entrySet()) {
          if (!first) {
            builder.append(',');
          }
          first = false;
          writeString(builder, String.valueOf(entry.getKey()));
          builder.append(':');
          writeJson(builder, entry.getValue());
        }
        builder.append('}');
      } else if (value instanceof Iterable<?> iterable) {
        builder.append('[');
        boolean first = true;
        for (Object item : iterable) {
          if (!first) {
            builder.append(',');
          }
          first = false;
          writeJson(builder, item);
        }
        builder.append(']');
      } else {
        writeString(builder, String.valueOf(value));
      }
    }

    private static void writeString(StringBuilder builder, String value) {
      builder.append('"');
      for (int i = 0; i < value.length(); i += 1) {
        char current = value.charAt(i);
        switch (current) {
          case '"' -> builder.append("\\\"");
          case '\\' -> builder.append("\\\\");
          case '\b' -> builder.append("\\b");
          case '\f' -> builder.append("\\f");
          case '\n' -> builder.append("\\n");
          case '\r' -> builder.append("\\r");
          case '\t' -> builder.append("\\t");
          default -> {
            if (current < 0x20) {
              builder.append(String.format("\\u%04x", (int) current));
            } else {
              builder.append(current);
            }
          }
        }
      }
      builder.append('"');
    }
  }
}
