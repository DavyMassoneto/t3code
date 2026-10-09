import { WS_METHODS } from "@t3tools/contracts";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { connectionAtomRuntime } from "../connection/runtime";

export const setPiConnectionApiKey = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:pi:connections:set-api-key",
  tag: WS_METHODS.serverSetPiConnectionApiKey,
});
