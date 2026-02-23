import { Plus, Trash2 } from "lucide-react";
import type React from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

const QUOTED_VALUE_RE = /^(['"])(.*)\1$/;

const envVarSchema = z.object({
	key: z.string(),
	value: z.string(),
});

const serviceSchema = z.object({
	path: z.string().min(1, "Path is required"),
	envVars: z.array(envVarSchema),
});

export const repositoryConfigSchema = z.object({
	setupCommand: z.string().min(1, "Setup command is required"),
	devCommand: z.string().min(1, "Dev command is required"),
	envVars: z.array(envVarSchema),
	services: z.array(serviceSchema),
});

export type ServiceValues = z.infer<typeof serviceSchema>;

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

type EnvVarArrayFieldState = {
	state: {
		value: { key: string; value: string }[];
	};
	pushValue: (val: { key: string; value: string }) => void;
	removeValue: (index: number) => void;
};

type ServicesArrayFieldState = {
	state: {
		value: ServiceValues[];
	};
	pushValue: (val: ServiceValues) => void;
	removeValue: (index: number) => void;
};

function parseEnvContent(text: string): { key: string; value: string }[] {
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
		.filter(Boolean) as { key: string; value: string }[];
}

// biome-ignore lint/suspicious/noExplicitAny: TanStack Form's ReactFormExtendedApi has 12 generic type parameters that can't be practically typed for a shared component
function EnvVarsFields({ form, name }: { form: any; name: string }) {
	return (
		<form.Field mode="array" name={name}>
			{(field: EnvVarArrayFieldState) => {
				const handleEnvPaste = (
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
							<FieldLabel>Environment Variables</FieldLabel>
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
								{field.state.value.map(
									(_: { key: string; value: string }, index: number) => (
										<div
											className="flex items-center gap-2"
											key={`env-${index.toString()}`}
										>
											<form.Field name={`${name}[${index}].key`}>
												{(subField: FieldState) => (
													<Input
														name={subField.name}
														onBlur={subField.handleBlur}
														onChange={(e) =>
															subField.handleChange(e.target.value)
														}
														onPaste={(e) => handleEnvPaste(e, index)}
														placeholder="KEY"
														value={subField.state.value}
													/>
												)}
											</form.Field>
											<form.Field name={`${name}[${index}].value`}>
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
									)
								)}
							</div>
						)}
					</div>
				);
			}}
		</form.Field>
	);
}

const emptyService: ServiceValues = {
	path: "",
	envVars: [{ key: "", value: "" }],
};

export function RepositoryConfigForm({
	form,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: TanStack Form's ReactFormExtendedApi has 12 generic type parameters that can't be practically typed for a shared component
	form: any;
}) {
	return (
		<>
			<FieldGroup>
				<form.Field name="setupCommand">
					{(field: FieldState) => {
						const isInvalid =
							field.state.meta.isTouched && !field.state.meta.isValid;
						return (
							<Field data-invalid={isInvalid}>
								<FieldLabel htmlFor={field.name}>Setup Command</FieldLabel>
								<Input
									aria-invalid={isInvalid}
									id={field.name}
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="e.g. npm install"
									value={field.state.value}
								/>
								{isInvalid && <FieldError errors={field.state.meta.errors} />}
							</Field>
						);
					}}
				</form.Field>

				<form.Field name="devCommand">
					{(field: FieldState) => {
						const isInvalid =
							field.state.meta.isTouched && !field.state.meta.isValid;
						return (
							<Field data-invalid={isInvalid}>
								<FieldLabel htmlFor={field.name}>Dev Command</FieldLabel>
								<Input
									aria-invalid={isInvalid}
									id={field.name}
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="e.g. npm run dev"
									value={field.state.value}
								/>
								{isInvalid && <FieldError errors={field.state.meta.errors} />}
							</Field>
						);
					}}
				</form.Field>

				<EnvVarsFields form={form} name="envVars" />
			</FieldGroup>

			<form.Field mode="array" name="services">
				{(servicesField: ServicesArrayFieldState) => (
					<div className="flex flex-col gap-4">
						<div className="flex items-center justify-between">
							<FieldLabel>Services</FieldLabel>
							<Button
								onClick={() => servicesField.pushValue({ ...emptyService })}
								size="xs"
								type="button"
								variant="ghost"
							>
								<Plus className="size-3" />
								Add Service
							</Button>
						</div>
						{servicesField.state.value.map(
							(_: ServiceValues, index: number) => (
								<div
									className="relative flex flex-col gap-3 border p-4"
									key={`service-${index.toString()}`}
								>
									<Button
										className="absolute top-2 right-2"
										onClick={() => servicesField.removeValue(index)}
										size="icon-sm"
										type="button"
										variant="ghost"
									>
										<Trash2 className="size-3.5" />
									</Button>
									<form.Field name={`services[${index}].path`}>
										{(field: FieldState) => {
											const isInvalid =
												field.state.meta.isTouched && !field.state.meta.isValid;
											return (
												<Field data-invalid={isInvalid}>
													<FieldLabel htmlFor={field.name}>Path</FieldLabel>
													<Input
														aria-invalid={isInvalid}
														id={field.name}
														name={field.name}
														onBlur={field.handleBlur}
														onChange={(e) => field.handleChange(e.target.value)}
														placeholder="e.g. apps/web (relative to repo root)"
														value={field.state.value}
													/>
													{isInvalid && (
														<FieldError errors={field.state.meta.errors} />
													)}
												</Field>
											);
										}}
									</form.Field>
									<EnvVarsFields
										form={form}
										name={`services[${index}].envVars`}
									/>
								</div>
							)
						)}
					</div>
				)}
			</form.Field>
		</>
	);
}
