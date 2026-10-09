import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const listPiConnections = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:pi:connections:list",
  tag: WS_METHODS.serverListPiConnections,
});
