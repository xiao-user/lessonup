import { Type, type TSchema } from "typebox";
import { z } from "zod";

/** Zod remains the canonical business schema; Pi receives the same JSON Schema. */
export function typeBoxFromZod<TSchemaValue extends z.ZodTypeAny>(schema: TSchemaValue) {
  return Type.Unsafe<z.infer<TSchemaValue>>(z.toJSONSchema(schema, {
    target: "draft-7",
    unrepresentable: "any",
  })) as unknown as TSchema & { static: z.infer<TSchemaValue> };
}
