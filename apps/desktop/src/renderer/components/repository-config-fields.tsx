import { Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
	Field,
	FieldError,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";

export type ServiceValues = {
	name: string;
	devCommand: string;
	cwd: string;
	envVars: { key: string; value: string }[];
};

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

type ArrayFieldState = {
	state: {
		value: { key: string; value: string }[];
	};
	pushValue: (val: { key: string; value: string }) => void;
	removeValue: (index: number) => void;
};

export function ServiceConfigFields({
	form,
	prefix,
	showName = true,
}: {
	// biome-ignore lint/suspicious/noExplicitAny: TanStack Form's ReactFormExtendedApi has 12 generic type parameters that can't be practically typed for a shared component
	form: any;
	prefix: string;
	showName?: boolean;
}) {
	const fieldName = (name: string) => (prefix ? `${prefix}.${name}` : name);

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
				{(field: ArrayFieldState) => (
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
