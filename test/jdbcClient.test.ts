import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { JdbcClient, JavaRunner } from "../src/jdbcClient";
import { ConnectionProfile } from "../src/types";

const profile: ConnectionProfile = {
  id: "1",
  name: "local",
  dbType: "h2",
  jdbcUrl: "jdbc:h2:mem:test",
  driverClass: "org.h2.Driver",
  driverJarPaths: ["/drivers/h2.jar"],
  supportJarPaths: ["/drivers/support.jar"],
  username: "sa",
  passwordSecretKey: "secret"
};

test("sends helper request with classpath and connection data", async () => {
  let capturedArgs: string[] = [];
  let capturedInput = "";
  const runner: JavaRunner = async (args, input) => {
    capturedArgs = args;
    capturedInput = input;
    return { code: 0, stdout: "{\"ok\":true,\"result\":{\"connected\":true}}", stderr: "" };
  };

  const client = new JdbcClient("/ext", runner);
  const result = await client.request<{ connected: boolean }>(profile, "password", "testConnection");

  assert.equal(result.connected, true);
  assert.equal(capturedArgs[0], "-cp");
  assert.equal(capturedArgs[1], [path.join("/ext", "java-helper", "build", "classes"), "/drivers/h2.jar", "/drivers/support.jar"].join(path.delimiter));
  assert.equal(capturedArgs[2], "com.example.dbviewer.JdbcHelper");
  assert.deepEqual(JSON.parse(capturedInput), {
    action: "testConnection",
    connection: {
      jdbcUrl: "jdbc:h2:mem:test",
      driverClass: "org.h2.Driver",
      username: "sa",
      password: "password"
    }
  });
});

test("raises helper error responses", async () => {
  const runner: JavaRunner = async () => ({
    code: 0,
    stdout: "{\"ok\":false,\"error\":\"bad credentials\"}",
    stderr: ""
  });
  const client = new JdbcClient("/ext", runner);

  await assert.rejects(
    () => client.request(profile, "password", "testConnection"),
    /bad credentials/
  );
});

test("adds Oracle i18n hint for ORA-17056", async () => {
  const runner: JavaRunner = async () => ({
    code: 0,
    stdout: "{\"ok\":false,\"error\":\"ORA-17056: Non supported character set\"}",
    stderr: ""
  });
  const client = new JdbcClient("/ext", runner);

  await assert.rejects(
    () => client.request(profile, "password", "testConnection"),
    /orai18n\.jar/
  );
});
