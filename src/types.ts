export type DatabaseType = "oracle" | "postgresql" | "mysql" | "h2" | "other";

export interface ConnectionProfile {
  id: string;
  name: string;
  dbType: DatabaseType;
  jdbcUrl: string;
  driverClass: string;
  driverJarPaths: string[];
  supportJarPaths: string[];
  username: string;
  passwordSecretKey: string;
}

export interface ConnectionInput {
  name: string;
  dbType: DatabaseType;
  jdbcUrl: string;
  driverClass: string;
  driverJarPaths: string[];
  supportJarPaths: string[];
  username: string;
  password?: string;
}

export interface ConnectionSecret {
  password: string;
}

export interface DbSchema {
  name: string;
}

export type DbObjectType = "TABLE" | "VIEW";

export interface DbObject {
  schema: string | null;
  name: string;
  type: DbObjectType;
}

export interface ColumnInfo {
  name: string;
  typeName: string;
  jdbcType: number | null;
  size: number | null;
  nullable: boolean;
  ordinal: number;
  defaultValue: string | null;
  remarks: string | null;
}

export type ConstraintType = "PRIMARY KEY" | "FOREIGN KEY" | "UNIQUE";

export interface ConstraintInfo {
  name: string | null;
  type: ConstraintType;
  columnName: string;
  ordinal: number | null;
  referencedSchema: string | null;
  referencedTable: string | null;
  referencedColumn: string | null;
}

export interface IndexInfo {
  name: string | null;
  unique: boolean;
  columnName: string | null;
  ordinal: number | null;
  sortOrder: string | null;
  type: string | null;
}

export interface ObjectInfo {
  schema: string | null;
  name: string;
  type: DbObjectType;
  columns: ColumnInfo[];
  primaryKeys: string[];
  constraints: ConstraintInfo[];
  indexes: IndexInfo[];
  identifierQuoteString: string;
}

export interface DataColumnInfo {
  name: string;
  typeName: string | null;
  jdbcType: number | null;
}

export interface ObjectData {
  columns: string[];
  columnTypes: DataColumnInfo[];
  rows: Array<Array<string | number | boolean | null>>;
  limit: number;
  offset: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

export interface ObjectDdl {
  ddl: string | null;
  message: string | null;
}

export interface InsertRowsRequest {
  object: DbObject;
  columns: string[];
  rows: Array<Array<string | null>>;
}

export interface InsertRowsResult {
  insertedRows: number;
}

export interface DeleteRowsResult {
  deletedRows: number;
}

export type HelperAction =
  | "testConnection"
  | "listSchemas"
  | "listTablesAndViews"
  | "getObjectInfo"
  | "getObjectData"
  | "getObjectDdl"
  | "insertRows"
  | "deleteRows";

export interface HelperConnection {
  jdbcUrl: string;
  driverClass: string;
  username: string;
  password: string;
}

export interface HelperRequest {
  action: HelperAction;
  connection: HelperConnection;
  object?: DbObject;
  limit?: number;
  offset?: number;
  where?: string;
  sortColumn?: string;
  sortDirection?: "ASC" | "DESC";
  columns?: string[];
  primaryKeyColumns?: string[];
  rows?: Array<Array<string | number | boolean | null>>;
}

export interface HelperResponse<T> {
  ok: boolean;
  result?: T;
  error?: string;
}
