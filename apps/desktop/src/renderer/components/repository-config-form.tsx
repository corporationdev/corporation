import { Plus, Trash2 } from "lucide-react";
import { z } from "zod";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const serviceSchema = z.object({
	name: z.string().min(1, "Service name is required"),
	devCommand: z.string().min(1, "Dev command is required"),
	cwd: z.string(),
	envVars: z.array(
		z.object({
			key: z.string().min(1, "Key is required"),
			value: z.string().min(1, "Value is required"),
		})
	),
});

export const repositoryConfigSchema = z.object({
	installCommand: z.string().min(1, "Install command is required"),
	services: z.array(serviceSchema).min(1, "At least one service is required"),
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

const emptyService: ServiceValues = {
	name: "",
	devCommand: "",
	cwd: "",
	envVars: [],
};

function ServiceConfigFields({
	form,
	prefix,
	showName = true,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: TanStack Form's ReactFormExtendedApi has 12 generic type parameters that can't be practically typed for a shared component
	form: any;
	prefix: string;
	showName?: boolean;
}) {
	const fieldName = (name: string) => `${prefix}.${name}`;

	return (
		<FieldGroup>
			{showName && (
				<form.Field name={fieldName("name")}>
					{(field: FieldState) => {
						const isInvalid =
							field.state.meta.isTouched && !field.state.meta.isValid;
						return (
							<Field data-invalid={isInvalid}>
								<FieldLabel htmlFor={field.name}>Service Name</FieldLabel>
								<Input
									aria-invalid={isInvalid}
									id={field.name}
									name={field.name}
									onBlur={field.handleBlur}
									onChange={(e) => field.handleChange(e.target.value)}
									placeholder="e.g. web, api, backend"
									value={field.state.value}
								/>
								{isInvalid && <FieldError errors={field.state.meta.errors} />}
							</Field>
						);
					}}
				</form.Field>
			)}

			<form.Field name={fieldName("devCommand")}>
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

			<form.Field name={fieldName("cwd")}>
				{(field: FieldState) => {
					const isInvalid =
						field.state.meta.isTouched && !field.state.meta.isValid;
					return (
						<Field data-invalid={isInvalid}>
							<FieldLabel htmlFor={field.name}>Working Directory</FieldLabel>
							<Input
								aria-invalid={isInvalid}
								id={field.name}
								name={field.name}
								onBlur={field.handleBlur}
								onChange={(e) => field.handleChange(e.target.value)}
								placeholder="e.g. apps/web (relative to repo root)"
								value={field.state.value}
							/>
							{isInvalid && <FieldError errors={field.state.meta.errors} />}
						</Field>
					);
				}}
			</form.Field>

			<form.Field mode="array" name={fieldName("envVars")}>
				{(field: EnvVarArrayFieldState) => (
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
						{field.state.value.length > 0 && (
							<div className="flex flex-col gap-2">
								{field.state.value.map(
									(_: { key: string; value: string }, index: number) => (
										<div
											className="flex items-center gap-2"
											key={`env-${index.toString()}`}
										>
											<form.Field
												name={`${fieldName("envVars")}[${index}].key`}
											>
												{(subField: FieldState) => (
													<Input
														name={subField.name}
														onBlur={subField.handleBlur}
														onChange={(e) =>
															subField.handleChange(e.target.value)
														}
														placeholder="KEY"
														value={subField.state.value}
													/>
												)}
											</form.Field>
											<form.Field
												name={`${fieldName("envVars")}[${index}].value`}
											>
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
				)}
			</form.Field>
		</FieldGroup>
	);
}

export function RepositoryConfigForm({
	form,
	isMonorepo,
	onMonorepoChange,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: TanStack Form's ReactFormExtendedApi has 12 generic type parameters that can't be practically typed for a shared component
	form: any;
	isMonorepo: boolean;
	onMonorepoChange: (value: boolean) => void;
}) {
	return (
		<>
			<Field>
				<FieldLabel htmlFor="installCommand">Install Command</FieldLabel>
				<form.Field name="installCommand">
					{(field: {
						name: string;
						state: { value: string };
						handleBlur: () => void;
						handleChange: (value: string) => void;
					}) => (
						<Input
							id={field.name}
							name={field.name}
							onBlur={field.handleBlur}
							onChange={(e) => field.handleChange(e.target.value)}
							placeholder="e.g. npm install"
							value={field.state.value}
						/>
					)}
				</form.Field>
			</Field>

			<Label>
				<Checkbox
					checked={isMonorepo}
					onCheckedChange={(checked) => onMonorepoChange(checked === true)}
				/>
				This is a monorepo
			</Label>

			{isMonorepo ? (
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
										{servicesField.state.value.length > 1 && (
											<Button
												className="absolute top-2 right-2"
												onClick={() => servicesField.removeValue(index)}
												size="icon-sm"
												type="button"
												variant="ghost"
											>
												<Trash2 className="size-3.5" />
											</Button>
										)}
										<ServiceConfigFields
											form={form}
											prefix={`services[${index}]`}
											showName
										/>
									</div>
								)
							)}
						</div>
					)}
				</form.Field>
			) : (
				<ServiceConfigFields
					form={form}
					prefix="services[0]"
					showName={false}
				/>
			)}
		</>
	);
}
