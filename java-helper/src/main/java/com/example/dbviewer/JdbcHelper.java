package com.example.dbviewer;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DatabaseMetaData;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.ResultSetMetaData;
import java.sql.SQLException;
import java.sql.Statement;
import java.sql.Time;
import java.sql.Timestamp;
import java.sql.Types;
import java.sql.Date;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
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
        case "getObjectData" -> getObjectData(
          connection,
          object(request),
          intValue(request.get("limit"), 100),
          intValue(request.get("offset"), 0),
          nullableString(request.get("where")),
          nullableString(request.get("sortColumn")),
          nullableString(request.get("sortDirection"))
        );
        case "getObjectDdl" -> getObjectDdl(connection, object(request));
        case "insertRows" -> insertRows(connection, object(request), stringList(request.get("columns")), rowList(request.get("rows")));
        case "deleteRows" -> deleteRows(connection, object(request), stringList(request.get("primaryKeyColumns")), rowList(request.get("rows")));
        case "updateRows" -> updateRows(connection, object(request), stringList(request.get("updateColumns")), stringList(request.get("primaryKeyColumns")), rowList(request.get("rows")));
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
        int jdbcType = rs.getInt("DATA_TYPE");
        column.put("jdbcType", rs.wasNull() ? null : jdbcType);
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

    List<Map<String, Object>> primaryKeyRows = isView(object) ? List.of() : safePrimaryKeys(metadata, object);
    List<String> primaryKeys = new ArrayList<>();
    for (Map<String, Object> row : primaryKeyRows) {
      primaryKeys.add(string(row.get("columnName")));
    }

    List<Map<String, Object>> indexes = isView(object) ? List.of() : safeIndexes(metadata, object);
    List<Map<String, Object>> constraints = new ArrayList<>();
    constraints.addAll(primaryKeyRows);
    if (!isView(object)) {
      constraints.addAll(safeForeignKeys(metadata, object));
    }
    constraints.addAll(uniqueConstraints(indexes));

    Map<String, Object> result = new LinkedHashMap<>();
    result.put("schema", object.schema());
    result.put("name", object.name());
    result.put("type", object.type());
    result.put("columns", columns);
    result.put("primaryKeys", primaryKeys);
    result.put("constraints", constraints);
    result.put("indexes", indexes);
    result.put("identifierQuoteString", normalizedIdentifierQuote(connection));
    return result;
  }

  private static List<Map<String, Object>> safePrimaryKeys(DatabaseMetaData metadata, DbObject object) {
    try {
      return getPrimaryKeys(metadata, object);
    } catch (SQLException error) {
      return List.of();
    }
  }

  private static List<Map<String, Object>> getPrimaryKeys(DatabaseMetaData metadata, DbObject object) throws SQLException {
    List<Map<String, Object>> primaryKeys = new ArrayList<>();
    try (ResultSet rs = metadata.getPrimaryKeys(null, object.schema(), object.name())) {
      while (rs.next()) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", rs.getString("PK_NAME"));
        row.put("type", "PRIMARY KEY");
        row.put("columnName", rs.getString("COLUMN_NAME"));
        short ordinal = rs.getShort("KEY_SEQ");
        row.put("ordinal", rs.wasNull() ? null : ordinal);
        row.put("referencedSchema", null);
        row.put("referencedTable", null);
        row.put("referencedColumn", null);
        primaryKeys.add(row);
      }
    }
    primaryKeys.sort(Comparator.comparingInt(row -> numberOrZero(row.get("ordinal"))));
    return primaryKeys;
  }

  private static List<Map<String, Object>> safeForeignKeys(DatabaseMetaData metadata, DbObject object) {
    try {
      return getForeignKeys(metadata, object);
    } catch (SQLException error) {
      return List.of();
    }
  }

  private static List<Map<String, Object>> getForeignKeys(DatabaseMetaData metadata, DbObject object) throws SQLException {
    List<Map<String, Object>> foreignKeys = new ArrayList<>();
    try (ResultSet rs = metadata.getImportedKeys(null, object.schema(), object.name())) {
      while (rs.next()) {
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", rs.getString("FK_NAME"));
        row.put("type", "FOREIGN KEY");
        row.put("columnName", rs.getString("FKCOLUMN_NAME"));
        short ordinal = rs.getShort("KEY_SEQ");
        row.put("ordinal", rs.wasNull() ? null : ordinal);
        row.put("referencedSchema", rs.getString("PKTABLE_SCHEM"));
        row.put("referencedTable", rs.getString("PKTABLE_NAME"));
        row.put("referencedColumn", rs.getString("PKCOLUMN_NAME"));
        foreignKeys.add(row);
      }
    }
    foreignKeys.sort(Comparator
      .comparing((Map<String, Object> row) -> string(row.get("name")))
      .thenComparingInt(row -> numberOrZero(row.get("ordinal"))));
    return foreignKeys;
  }

  private static List<Map<String, Object>> safeIndexes(DatabaseMetaData metadata, DbObject object) {
    try {
      return getIndexes(metadata, object);
    } catch (SQLException error) {
      return List.of();
    }
  }

  private static List<Map<String, Object>> getIndexes(DatabaseMetaData metadata, DbObject object) throws SQLException {
    List<Map<String, Object>> indexes = new ArrayList<>();
    try (ResultSet rs = metadata.getIndexInfo(null, object.schema(), object.name(), false, false)) {
      while (rs.next()) {
        short type = rs.getShort("TYPE");
        if (type == DatabaseMetaData.tableIndexStatistic) {
          continue;
        }
        Map<String, Object> row = new LinkedHashMap<>();
        row.put("name", rs.getString("INDEX_NAME"));
        row.put("unique", !rs.getBoolean("NON_UNIQUE"));
        row.put("columnName", rs.getString("COLUMN_NAME"));
        short ordinal = rs.getShort("ORDINAL_POSITION");
        row.put("ordinal", rs.wasNull() ? null : ordinal);
        row.put("sortOrder", rs.getString("ASC_OR_DESC"));
        row.put("type", indexTypeName(type));
        indexes.add(row);
      }
    }
    indexes.sort(Comparator
      .comparing((Map<String, Object> row) -> string(row.get("name")))
      .thenComparingInt(row -> numberOrZero(row.get("ordinal"))));
    return indexes;
  }

  private static List<Map<String, Object>> uniqueConstraints(List<Map<String, Object>> indexes) {
    List<Map<String, Object>> constraints = new ArrayList<>();
    for (Map<String, Object> index : indexes) {
      if (!Boolean.TRUE.equals(index.get("unique")) || string(index.get("name")).isBlank()) {
        continue;
      }
      Map<String, Object> row = new LinkedHashMap<>();
      row.put("name", index.get("name"));
      row.put("type", "UNIQUE");
      row.put("columnName", index.get("columnName"));
      row.put("ordinal", index.get("ordinal"));
      row.put("referencedSchema", null);
      row.put("referencedTable", null);
      row.put("referencedColumn", null);
      constraints.add(row);
    }
    return constraints;
  }

  private static String indexTypeName(short type) {
    return switch (type) {
      case DatabaseMetaData.tableIndexClustered -> "CLUSTERED";
      case DatabaseMetaData.tableIndexHashed -> "HASHED";
      case DatabaseMetaData.tableIndexOther -> "OTHER";
      default -> "";
    };
  }

  private static Map<String, Object> getObjectData(
    Connection connection,
    DbObject object,
    int limit,
    int offset,
    String where,
    String sortColumn,
    String sortDirection
  ) throws SQLException {
    int safeLimit = Math.max(1, Math.min(limit, 1000));
    int safeOffset = Math.max(0, offset);
    String baseSql = dataSql(connection, object, where, sortColumn, sortDirection);
    String sql = baseSql + " offset " + safeOffset + " rows fetch next " + (safeLimit + 1) + " rows only";
    try (Statement statement = connection.createStatement()) {
      try {
        return readRows(statement, sql, safeLimit, safeOffset, 0);
      } catch (SQLException firstError) {
        statement.setMaxRows(safeLimit + safeOffset + 1);
        return readRows(statement, baseSql, safeLimit, safeOffset, safeOffset);
      }
    }
  }

  private static String dataSql(Connection connection, DbObject object, String where, String sortColumn, String sortDirection) throws SQLException {
    StringBuilder sql = new StringBuilder("select * from ").append(qualifiedName(connection, object));
    if (where != null && !where.isBlank()) {
      String condition = where.trim();
      if (condition.contains(";")) {
        throw new SQLException("Search condition must not contain semicolons.");
      }
      sql.append(" where ").append(condition);
    }
    if (sortColumn != null && !sortColumn.isBlank()) {
      sql.append(" order by ").append(quote(connection, sortColumn.trim()));
      sql.append("DESC".equalsIgnoreCase(sortDirection) ? " DESC" : " ASC");
    }
    return sql.toString();
  }

  private static Map<String, Object> readRows(Statement statement, String sql, int limit, int offset, int rowsToSkip) throws SQLException {
    try (ResultSet rs = statement.executeQuery(sql)) {
      ResultSetMetaData metadata = rs.getMetaData();
      List<String> columns = new ArrayList<>();
      List<Map<String, Object>> columnTypes = new ArrayList<>();
      for (int i = 1; i <= metadata.getColumnCount(); i += 1) {
        String columnName = metadata.getColumnLabel(i);
        columns.add(columnName);
        Map<String, Object> columnType = new LinkedHashMap<>();
        columnType.put("name", columnName);
        columnType.put("typeName", metadata.getColumnTypeName(i));
        columnType.put("jdbcType", metadata.getColumnType(i));
        columnTypes.add(columnType);
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
      result.put("columnTypes", columnTypes);
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

  private static Map<String, Object> insertRows(
    Connection connection,
    DbObject object,
    List<String> columns,
    List<List<Object>> rows
  ) throws SQLException {
    if (isView(object)) {
      throw new SQLException("TSV Insert is available for tables only.");
    }
    if (columns.isEmpty()) {
      throw new SQLException("Insert columns are required.");
    }
    if (rows.isEmpty()) {
      throw new SQLException("Insert rows are required.");
    }
    for (int i = 0; i < rows.size(); i += 1) {
      if (rows.get(i).size() != columns.size()) {
        throw new SQLException("Row " + (i + 1) + " has " + rows.get(i).size() + " value(s), expected " + columns.size() + ".");
      }
    }

    boolean originalAutoCommit = connection.getAutoCommit();
    connection.setAutoCommit(false);
    int insertedRows = 0;
    Map<String, Integer> jdbcTypes = columnJdbcTypes(connection, object, columns);
    try (PreparedStatement statement = connection.prepareStatement(insertSql(connection, object, columns))) {
      for (List<Object> row : rows) {
        for (int i = 0; i < row.size(); i += 1) {
          int jdbcType = jdbcTypes.get(columns.get(i));
          bindInsertValue(statement, i + 1, row.get(i), jdbcType);
        }
        statement.addBatch();
      }
      int[] counts = statement.executeBatch();
      for (int count : counts) {
        if (count > 0) {
          insertedRows += count;
        } else if (count == Statement.SUCCESS_NO_INFO) {
          insertedRows += 1;
        }
      }
      connection.commit();
      return Map.of("insertedRows", insertedRows);
    } catch (SQLException error) {
      connection.rollback();
      throw error;
    } finally {
      connection.setAutoCommit(originalAutoCommit);
    }
  }

  private static String insertSql(Connection connection, DbObject object, List<String> columns) throws SQLException {
    StringBuilder sql = new StringBuilder("insert into ");
    sql.append(qualifiedName(connection, object)).append(" (");
    for (int i = 0; i < columns.size(); i += 1) {
      if (i > 0) {
        sql.append(", ");
      }
      sql.append(quote(connection, columns.get(i)));
    }
    sql.append(") values (");
    for (int i = 0; i < columns.size(); i += 1) {
      if (i > 0) {
        sql.append(", ");
      }
      sql.append("?");
    }
    sql.append(")");
    return sql.toString();
  }

  private static Map<String, Object> deleteRows(
    Connection connection,
    DbObject object,
    List<String> primaryKeyColumns,
    List<List<Object>> rows
  ) throws SQLException {
    if (isView(object)) {
      throw new SQLException("Selected row delete is available for tables only.");
    }
    if (primaryKeyColumns.isEmpty()) {
      throw new SQLException("Primary key columns are required.");
    }
    if (rows.isEmpty()) {
      throw new SQLException("Delete rows are required.");
    }
    for (int i = 0; i < rows.size(); i += 1) {
      if (rows.get(i).size() != primaryKeyColumns.size()) {
        throw new SQLException("Row " + (i + 1) + " has " + rows.get(i).size() + " primary key value(s), expected " + primaryKeyColumns.size() + ".");
      }
    }

    boolean originalAutoCommit = connection.getAutoCommit();
    connection.setAutoCommit(false);
    int deletedRows = 0;
    Map<String, Integer> jdbcTypes = columnJdbcTypes(connection, object, primaryKeyColumns);
    try (PreparedStatement statement = connection.prepareStatement(deleteSql(connection, object, primaryKeyColumns))) {
      for (List<Object> row : rows) {
        for (int i = 0; i < row.size(); i += 1) {
          int jdbcType = jdbcTypes.get(primaryKeyColumns.get(i));
          bindInsertValue(statement, i + 1, row.get(i), jdbcType);
        }
        statement.addBatch();
      }
      int[] counts = statement.executeBatch();
      for (int count : counts) {
        if (count > 0) {
          deletedRows += count;
        } else if (count == Statement.SUCCESS_NO_INFO) {
          deletedRows += 1;
        }
      }
      connection.commit();
      return Map.of("deletedRows", deletedRows);
    } catch (SQLException error) {
      connection.rollback();
      throw error;
    } finally {
      connection.setAutoCommit(originalAutoCommit);
    }
  }

  private static String deleteSql(Connection connection, DbObject object, List<String> primaryKeyColumns) throws SQLException {
    StringBuilder sql = new StringBuilder("delete from ");
    sql.append(qualifiedName(connection, object)).append(" where ");
    for (int i = 0; i < primaryKeyColumns.size(); i += 1) {
      if (i > 0) {
        sql.append(" and ");
      }
      sql.append(quote(connection, primaryKeyColumns.get(i))).append(" = ?");
    }
    return sql.toString();
  }

  private static Map<String, Object> updateRows(
    Connection connection,
    DbObject object,
    List<String> updateColumns,
    List<String> primaryKeyColumns,
    List<List<Object>> rows
  ) throws SQLException {
    if (isView(object)) {
      throw new SQLException("Selected row update is available for tables only.");
    }
    if (updateColumns.isEmpty()) {
      throw new SQLException("Update columns are required.");
    }
    if (primaryKeyColumns.isEmpty()) {
      throw new SQLException("Primary key columns are required.");
    }
    if (rows.isEmpty()) {
      throw new SQLException("Update rows are required.");
    }
    int expectedValues = updateColumns.size() + primaryKeyColumns.size();
    for (int i = 0; i < rows.size(); i += 1) {
      if (rows.get(i).size() != expectedValues) {
        throw new SQLException("Row " + (i + 1) + " has " + rows.get(i).size() + " value(s), expected " + expectedValues + ".");
      }
    }

    boolean originalAutoCommit = connection.getAutoCommit();
    connection.setAutoCommit(false);
    int updatedRows = 0;
    List<String> parameterColumns = new ArrayList<>();
    parameterColumns.addAll(updateColumns);
    parameterColumns.addAll(primaryKeyColumns);
    Map<String, Integer> jdbcTypes = columnJdbcTypes(connection, object, parameterColumns);
    try (PreparedStatement statement = connection.prepareStatement(updateSql(connection, object, updateColumns, primaryKeyColumns))) {
      for (List<Object> row : rows) {
        for (int i = 0; i < row.size(); i += 1) {
          int jdbcType = jdbcTypes.get(parameterColumns.get(i));
          bindInsertValue(statement, i + 1, row.get(i), jdbcType);
        }
        statement.addBatch();
      }
      int[] counts = statement.executeBatch();
      for (int count : counts) {
        if (count > 0) {
          updatedRows += count;
        } else if (count == Statement.SUCCESS_NO_INFO) {
          updatedRows += 1;
        }
      }
      connection.commit();
      return Map.of("updatedRows", updatedRows);
    } catch (SQLException error) {
      connection.rollback();
      throw error;
    } finally {
      connection.setAutoCommit(originalAutoCommit);
    }
  }

  private static String updateSql(Connection connection, DbObject object, List<String> updateColumns, List<String> primaryKeyColumns) throws SQLException {
    StringBuilder sql = new StringBuilder("update ");
    sql.append(qualifiedName(connection, object)).append(" set ");
    for (int i = 0; i < updateColumns.size(); i += 1) {
      if (i > 0) {
        sql.append(", ");
      }
      sql.append(quote(connection, updateColumns.get(i))).append(" = ?");
    }
    sql.append(" where ");
    for (int i = 0; i < primaryKeyColumns.size(); i += 1) {
      if (i > 0) {
        sql.append(" and ");
      }
      sql.append(quote(connection, primaryKeyColumns.get(i))).append(" = ?");
    }
    return sql.toString();
  }

  private static Map<String, Integer> columnJdbcTypes(Connection connection, DbObject object, List<String> columns) throws SQLException {
    DatabaseMetaData metadata = connection.getMetaData();
    Map<String, Integer> available = new HashMap<>();
    try (ResultSet rs = metadata.getColumns(null, object.schema(), object.name(), "%")) {
      while (rs.next()) {
        String name = rs.getString("COLUMN_NAME");
        int jdbcType = rs.getInt("DATA_TYPE");
        if (!rs.wasNull()) {
          available.put(name, jdbcType);
          available.put(name.toUpperCase(), jdbcType);
          available.put(name.toLowerCase(), jdbcType);
        }
      }
    }

    Map<String, Integer> result = new LinkedHashMap<>();
    for (String column : columns) {
      Integer jdbcType = available.get(column);
      if (jdbcType == null) {
        throw new SQLException("Column metadata is not available for insert column: " + column);
      }
      result.put(column, jdbcType);
    }
    return result;
  }

  private static void bindInsertValue(PreparedStatement statement, int parameterIndex, Object value, int jdbcType) throws SQLException {
    if (value == null) {
      statement.setNull(parameterIndex, jdbcType);
      return;
    }
    String text = String.valueOf(value);
    try {
      statement.setObject(parameterIndex, typedInsertValue(text, jdbcType), jdbcType);
    } catch (RuntimeException error) {
      throw new SQLException("Value '" + text + "' cannot be converted for parameter " + parameterIndex + " (JDBC type " + jdbcType + ").", error);
    }
  }

  private static Object typedInsertValue(String value, int jdbcType) {
    return switch (jdbcType) {
      case Types.TINYINT, Types.SMALLINT, Types.INTEGER -> Integer.valueOf(value);
      case Types.BIGINT -> Long.valueOf(value);
      case Types.REAL, Types.FLOAT -> Float.valueOf(value);
      case Types.DOUBLE -> Double.valueOf(value);
      case Types.NUMERIC, Types.DECIMAL -> new BigDecimal(value);
      case Types.BOOLEAN, Types.BIT -> parseBoolean(value);
      case Types.DATE -> Date.valueOf(value);
      case Types.TIME, Types.TIME_WITH_TIMEZONE -> Time.valueOf(value);
      case Types.TIMESTAMP -> Timestamp.valueOf(value.replace("T", " "));
      case Types.TIMESTAMP_WITH_TIMEZONE -> OffsetDateTime.parse(value);
      default -> value;
    };
  }

  private static Boolean parseBoolean(String value) {
    String normalized = value.trim().toLowerCase();
    return switch (normalized) {
      case "true", "t", "1", "yes", "y" -> Boolean.TRUE;
      case "false", "f", "0", "no", "n" -> Boolean.FALSE;
      default -> throw new IllegalArgumentException("Invalid boolean value: " + value);
    };
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

  private static boolean isView(DbObject object) {
    return "VIEW".equalsIgnoreCase(object.type());
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

  private static List<String> stringList(Object value) {
    if (!(value instanceof List<?> list)) {
      return List.of();
    }
    List<String> result = new ArrayList<>();
    for (Object item : list) {
      result.add(string(item));
    }
    return result;
  }

  private static List<List<Object>> rowList(Object value) {
    if (!(value instanceof List<?> list)) {
      return List.of();
    }
    List<List<Object>> result = new ArrayList<>();
    for (Object rawRow : list) {
      if (!(rawRow instanceof List<?> row)) {
        throw new IllegalArgumentException("Each row must be an array.");
      }
      result.add(new ArrayList<>(row));
    }
    return result;
  }

  private static int numberOrZero(Object value) {
    return value instanceof Number number ? number.intValue() : 0;
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
