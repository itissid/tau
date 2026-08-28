export const SAFETY_GATE_PENDING_EVENT = "safety-gate:pending";
export const SAFETY_GATE_RESPONSE_EVENT = "safety-gate:response";
export const SAFETY_GATE_SETTLED_EVENT = "safety-gate:settled";

export type SafetyGatePendingRequest = {
	type: "extension_ui_request";
	schemaVersion: 1;
	requestKind: "safety-gate";
	id: string;
	method: "confirm";
	title: string;
	message: string;
	operation: string;
	createdAt: string;
};

export type SafetyGateResponse = {
	schemaVersion: 1;
	id: string;
	answer: "approve" | "deny" | "cancel";
};

export type SafetyGateSettlement = {
	schemaVersion: 1;
	id: string;
	answer: "approve" | "deny" | "cancel";
	source: "terminal" | "browser" | "pi";
};

const REQUEST_ID_PATTERN = /^safety-gate-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATIONS = new Set(["bash", "read", "grep", "find", "ls", "write", "edit", "shell"]);

function hasExactKeys(value: object, keys: string[]): boolean {
	const actual = Object.keys(value).sort();
	return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isBoundedString(value: unknown, maximumLength: number): value is string {
	return typeof value === "string" && value.length > 0 && value.length <= maximumLength;
}

function isRequestId(value: unknown): value is string {
	return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function isSafetyGatePendingRequest(value: unknown): value is SafetyGatePendingRequest {
	if (!value || typeof value !== "object") return false;
	const request = value as Partial<SafetyGatePendingRequest>;
	return (
		hasExactKeys(request, ["createdAt", "id", "message", "method", "operation", "requestKind", "schemaVersion", "title", "type"]) &&
		request.type === "extension_ui_request" &&
		request.schemaVersion === 1 &&
		request.requestKind === "safety-gate" &&
		isRequestId(request.id) &&
		request.method === "confirm" &&
		isBoundedString(request.title, 160) &&
		isBoundedString(request.message, 240) &&
		typeof request.operation === "string" &&
		OPERATIONS.has(request.operation) &&
		isBoundedString(request.createdAt, 64) &&
		Number.isFinite(Date.parse(request.createdAt))
	);
}

export function isSafetyGateResponse(value: unknown): value is SafetyGateResponse {
	if (!value || typeof value !== "object") return false;
	const response = value as Partial<SafetyGateResponse>;
	return (
		hasExactKeys(response, ["answer", "id", "schemaVersion"]) &&
		response.schemaVersion === 1 &&
		isRequestId(response.id) &&
		(response.answer === "approve" || response.answer === "deny" || response.answer === "cancel")
	);
}

export function isSafetyGateSettlement(value: unknown): value is SafetyGateSettlement {
	if (!value || typeof value !== "object") return false;
	const settlement = value as Partial<SafetyGateSettlement>;
	return (
		hasExactKeys(settlement, ["answer", "id", "schemaVersion", "source"]) &&
		settlement.schemaVersion === 1 &&
		isRequestId(settlement.id) &&
		(settlement.answer === "approve" || settlement.answer === "deny" || settlement.answer === "cancel") &&
		(settlement.source === "terminal" || settlement.source === "browser" || settlement.source === "pi")
	);
}
