import { DatabaseType } from "./types";

export interface DatabaseTypeOption {
  label: string;
  value: DatabaseType;
  defaultDriverClass: string;
  jdbcUrlExample: string;
}

export const DATABASE_TYPES: DatabaseTypeOption[] = [
  { label: "Oracle", value: "oracle", defaultDriverClass: "oracle.jdbc.OracleDriver", jdbcUrlExample: "jdbc:oracle:thin:@//localhost:1521/FREEPDB1" },
  { label: "PostgreSQL", value: "postgresql", defaultDriverClass: "org.postgresql.Driver", jdbcUrlExample: "jdbc:postgresql://localhost:5432/postgres" },
  { label: "MySQL", value: "mysql", defaultDriverClass: "com.mysql.cj.jdbc.Driver", jdbcUrlExample: "jdbc:mysql://localhost:3306/app" },
  { label: "Microsoft SQL Server", value: "sqlserver", defaultDriverClass: "com.microsoft.sqlserver.jdbc.SQLServerDriver", jdbcUrlExample: "jdbc:sqlserver://localhost:1433;databaseName=database;encrypt=true" },
  { label: "H2", value: "h2", defaultDriverClass: "org.h2.Driver", jdbcUrlExample: "jdbc:h2:mem:test" },
  { label: "Other", value: "other", defaultDriverClass: "", jdbcUrlExample: "jdbc:vendor://host:port/database" }
];
