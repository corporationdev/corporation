import { oc } from "@orpc/contract";
import { z } from "zod";
import {
	runtimeCancelTurnMessageSchema,
	runtimeProbeAgentsMessageSchema,
	runtimeStartTurnMessageSchema,
} from "../sandbox-do";

export const runtimeControlContract = {
	startTurn: oc.input(runtimeStartTurnMessageSchema).output(z.null()),
	cancelTurn: oc.input(runtimeCancelTurnMessageSchema).output(z.null()),
	probeAgents: oc.input(runtimeProbeAgentsMessageSchema).output(z.null()),
};
