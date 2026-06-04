import { spawn } from "child_process";
import * as path from "path";
import { ConnectionProfile, HelperRequest, HelperResponse } from "./types";

export interface JavaProcessResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export type JavaRunner = (args: string[], input: string) => Promise<JavaProcessResult>;

export class JdbcClient {
  constructor(
    private readonly extensionPath: string,
    private readonly runner: JavaRunner = defaultJavaRunner
  ) {}

  async request<T>(
    profile: ConnectionProfile,
    password: string,
    action: HelperRequest["action"],
    payload: Omit<HelperRequest, "action" | "connection"> = {}
  ): Promise<T> {
    const request: HelperRequest = {
      ...payload,
      action,
      connection: {
        jdbcUrl: profile.jdbcUrl,
        driverClass: profile.driverClass,
        username: profile.username,
        password
      }
    };
    const classpath = this.createClasspath([...profile.driverJarPaths, ...profile.supportJarPaths]);
    const result = await this.runner(["-cp", classpath, "com.example.dbviewer.JdbcHelper"], JSON.stringify(request));

    if (result.code !== 0) {
      throw new Error(result.stderr.trim() || `Java helper exited with code ${result.code}`);
    }

    let response: HelperResponse<T>;
    try {
      response = JSON.parse(result.stdout) as HelperResponse<T>;
    } catch (error) {
      throw new Error(`Java helper returned invalid JSON: ${(error as Error).message}`);
    }

    if (!response.ok) {
      throw new Error(enrichHelperError(response.error ?? "Java helper request failed"));
    }

    return response.result as T;
  }

  private createClasspath(driverJarPaths: string[]): string {
    const helperClasses = path.join(this.extensionPath, "java-helper", "build", "classes");
    return [helperClasses, ...driverJarPaths].join(path.delimiter);
  }
}

function enrichHelperError(message: string): string {
  if (message.includes("ORA-17056")) {
    return `${message}\nOracle ORA-17056 usually means the Oracle JDBC internationalization support JAR is missing. Add orai18n.jar together with ojdbc*.jar in this connection's JDBC JAR selection.`;
  }
  return message;
}

function defaultJavaRunner(args: string[], input: string): Promise<JavaProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("java", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(new Error(`Failed to start Java. Ensure Java is installed and on PATH. ${error.message}`));
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code });
    });
    child.stdin.end(input);
  });
}
