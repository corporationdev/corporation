import {
	validateSecretName as validateName,
	validateSecretValue as validateValue,
} from "@corporation/shared/secrets";
import { PencilLine, Plus, Trash2, X } from "lucide-react";
import type React from "react";
import { useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const QUOTED_VALUE_RE = /^(['"])(.*)\1$/;

const secretEntrySchema = z.object({
	key: z.string(),
	value: z.string(),
	hint: z.optional(z.string()),
	isStored: z.optional(z.boolean()),
});

function validateSecretName({ value }: { value: unknown }): string | undefined {
	const str = String(value).trim();
	if (!str) {
		return undefined;
	}
	return validateName(str);
}

function validateSecretValue({
	value,
}: {
	value: unknown;
}): string | undefined {
	return validateValue(String(value));
}

export const projectConfigSchema = z.object({
	secrets: z.array(secretEntrySchema),
});

export type SecretEntry = z.infer<typeof secretEntrySchema>;
export type StoredSecret = {
	name: string;
	hint: string;
	updatedAt: number;
};

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

export function buildSecretChanges(
	initialSecrets: SecretEntry[],
	nextSecrets: SecretEntry[]
): {
	upserts: Record<string, string>;
	removeNames: string[];
} {
	const initialStoredSecretNames = new Set(
		initialSecrets
			.filter((secret) => secret.isStored)
			.map((secret) => secret.key.trim())
			.filter(Boolean)
	);
	const retainedStoredSecretNames = new Set<string>();
	const upserts: Record<string, string> = {};

	for (const secret of nextSecrets) {
		const trimmedKey = secret.key.trim();
		if (!trimmedKey) {
			continue;
		}

		if (secret.isStored) {
			retainedStoredSecretNames.add(trimmedKey);
		}

		if (!secret.isStored || secret.value.length > 0) {
			upserts[trimmedKey] = secret.value;
		}
	}

	return {
		upserts,
		removeNames: Array.from(initialStoredSecretNames).filter(
			(name) => !retainedStoredSecretNames.has(name)
		),
	};
}

export function secretsFromMetadata(
	secrets: StoredSecret[] | undefined | null
): SecretEntry[] {
	if (!secrets || secrets.length === 0) {
		return [{ key: "", value: "" }];
	}
	return secrets.map((secret) => ({
		key: secret.name,
		value: "",
		hint: secret.hint,
		isStored: true,
	}));
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
		value: unknown;
		meta: {
			isTouched: boolean;
			isValid: boolean;
			errors: Array<{ message?: string } | undefined>;
		};
	};
	handleBlur: () => void;
	handleChange: (value: unknown) => void;
};

type SecretEntryArrayFieldState = {
	state: {
		value: SecretEntry[];
	};
	pushValue: (val: SecretEntry) => void;
	removeValue: (index: number) => void;
};

function FieldError({
	errors,
}: {
	errors: Array<{ message?: string } | string | undefined>;
}) {
	const message = errors
		.map((e) => (typeof e === "string" ? e : e?.message))
		.find(Boolean);
	if (!message) {
		return null;
	}
	return <p className="text-destructive text-xs">{message}</p>;
}

// biome-ignore lint/suspicious/noExplicitAny: TanStack Form's ReactFormExtendedApi has 12 generic type parameters that can't be practically typed for a shared component
export function ProjectConfigForm({ form }: { form: any }) {
	const [editingIndices, setEditingIndices] = useState<Set<number>>(new Set());

	const startEditing = (index: number) => {
		setEditingIndices((prev) => new Set(prev).add(index));
	};

	const stopEditing = (index: number) => {
		setEditingIndices((prev) => {
			const next = new Set(prev);
			next.delete(index);
			return next;
		});
	};

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
								onClick={() =>
									field.pushValue({
										key: "",
										value: "",
										isStored: false,
									})
								}
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
								{field.state.value.map((_: SecretEntry, index: number) => {
									const entry = field.state.value[index];
									const isStored = Boolean(entry?.isStored);
									const isEditing = editingIndices.has(index);

									return (
										<div
											className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2"
											key={`secret-${index.toString()}`}
										>
											<form.Field
												name={`secrets[${index}].key`}
												validators={
													isStored ? undefined : { onBlur: validateSecretName }
												}
											>
												{(subField: FieldState) => (
													<div className="flex flex-col gap-1">
														<Input
															disabled={isStored}
															name={subField.name}
															onBlur={subField.handleBlur}
															onChange={(e) =>
																subField.handleChange(e.target.value)
															}
															onPaste={(e) => handlePaste(e, index)}
															placeholder="KEY"
															value={String(subField.state.value)}
														/>
														<FieldError errors={subField.state.meta.errors} />
													</div>
												)}
											</form.Field>
											{isStored && !isEditing ? (
												<Input disabled value={entry?.hint || "••••••••"} />
											) : (
												<form.Field
													name={`secrets[${index}].value`}
													validators={{ onBlur: validateSecretValue }}
												>
													{(subField: FieldState) => (
														<div className="flex flex-col gap-1">
															<Input
																name={subField.name}
																onBlur={subField.handleBlur}
																onChange={(e) =>
																	subField.handleChange(e.target.value)
																}
																placeholder="VALUE"
																type="password"
																value={String(subField.state.value)}
															/>
															<FieldError errors={subField.state.meta.errors} />
														</div>
													)}
												</form.Field>
											)}
											<div className="flex items-center">
												{isStored && (
													<Button
														onClick={() => {
															if (isEditing) {
																stopEditing(index);
															} else {
																startEditing(index);
															}
														}}
														size="icon-sm"
														type="button"
														variant="ghost"
													>
														{isEditing ? (
															<X className="size-3.5" />
														) : (
															<PencilLine className="size-3.5" />
														)}
													</Button>
												)}
												<Button
													onClick={() => field.removeValue(index)}
													size="icon-sm"
													type="button"
													variant="ghost"
												>
													<Trash2 className="size-3.5" />
												</Button>
											</div>
										</div>
									);
								})}
							</div>
						)}
					</div>
				);
			}}
		</form.Field>
	);
}
