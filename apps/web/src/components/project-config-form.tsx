import { Plus, Trash2 } from "lucide-react";
import type React from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const QUOTED_VALUE_RE = /^(['"])(.*)\1$/;

const secretEntrySchema = z.object({
	key: z.string(),
	value: z.string(),
});

export const projectConfigSchema = z.object({
	secrets: z.array(secretEntrySchema),
});

export type SecretEntry = z.infer<typeof secretEntrySchema>;

export function buildSecrets(secrets: SecretEntry[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const { key, value } of secrets) {
		const trimmedKey = key.trim();
		if (trimmedKey) {
			result[trimmedKey] = value;
		}
	}
	return result;
}

export function secretsFromRecord(
	secrets: Record<string, string> | undefined | null
): SecretEntry[] {
	if (!secrets || Object.keys(secrets).length === 0) {
		return [{ key: "", value: "" }];
	}
	return Object.entries(secrets).map(([key, value]) => ({ key, value }));
}

function parseEnvContent(text: string): SecretEntry[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => {
			const eqIndex = line.indexOf("=");
			if (eqIndex === -1) {
				return null;
			}
			const key = line.slice(0, eqIndex).trim();
			const raw = line.slice(eqIndex + 1).trim();
			const value = raw.replace(QUOTED_VALUE_RE, "$2");
			return key ? { key, value } : null;
		})
		.filter(Boolean) as SecretEntry[];
}

type FieldState = {
	name: string;
	state: {
		value: string;
		meta: {
			isTouched: boolean;
			isValid: boolean;
			errors: Array<{ message?: string } | undefined>;
		};
	};
	handleBlur: () => void;
	handleChange: (value: string) => void;
};

type SecretEntryArrayFieldState = {
	state: {
		value: SecretEntry[];
	};
	pushValue: (val: SecretEntry) => void;
	removeValue: (index: number) => void;
};

// biome-ignore lint/suspicious/noExplicitAny: TanStack Form's ReactFormExtendedApi has 12 generic type parameters that can't be practically typed for a shared component
export function ProjectConfigForm({ form }: { form: any }) {
	return (
		<form.Field mode="array" name="secrets">
			{(field: SecretEntryArrayFieldState) => {
				const handlePaste = (
					e: React.ClipboardEvent<HTMLInputElement>,
					index: number
				) => {
					const text = e.clipboardData.getData("text");
					if (!text.includes("\n")) {
						return;
					}
					const parsed = parseEnvContent(text);
					if (parsed.length === 0) {
						return;
					}
					e.preventDefault();
					const current = field.state.value[index];
					if (current && !current.key.trim() && !current.value.trim()) {
						field.removeValue(index);
					}
					for (const pair of parsed) {
						field.pushValue(pair);
					}
				};

				return (
					<div className="flex flex-col gap-2">
						<div className="flex items-center justify-between">
							<FieldLabel>Secrets</FieldLabel>
							<Button
								onClick={() => field.pushValue({ key: "", value: "" })}
								size="xs"
								type="button"
								variant="ghost"
							>
								<Plus className="size-3" />
								Add
							</Button>
						</div>
						{field.state.value?.length > 0 && (
							<div className="flex flex-col gap-2">
								{field.state.value.map((_: SecretEntry, index: number) => (
									<div
										className="flex items-center gap-2"
										key={`secret-${index.toString()}`}
									>
										<form.Field name={`secrets[${index}].key`}>
											{(subField: FieldState) => (
												<Input
													name={subField.name}
													onBlur={subField.handleBlur}
													onChange={(e) =>
														subField.handleChange(e.target.value)
													}
													onPaste={(e) => handlePaste(e, index)}
													placeholder="KEY"
													value={subField.state.value}
												/>
											)}
										</form.Field>
										<form.Field name={`secrets[${index}].value`}>
											{(subField: FieldState) => (
												<Input
													name={subField.name}
													onBlur={subField.handleBlur}
													onChange={(e) =>
														subField.handleChange(e.target.value)
													}
													placeholder="value"
													value={subField.state.value}
												/>
											)}
										</form.Field>
										<Button
											onClick={() => field.removeValue(index)}
											size="icon-sm"
											type="button"
											variant="ghost"
										>
											<Trash2 className="size-3.5" />
										</Button>
									</div>
								))}
							</div>
						)}
					</div>
				);
			}}
		</form.Field>
	);
}
