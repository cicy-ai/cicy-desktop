const { z } = require("zod");

function zodToJsonSchema(zodSchema) {
  const shape = zodSchema._def.shape ? zodSchema._def.shape() : {};
  const properties = {};
  const required = [];

  for (const [key, value] of Object.entries(shape)) {
    let fieldDef = value._def;
    let fieldSchema = { type: "string" };

    // Unwrap ZodOptional and ZodDefault
    while (fieldDef.typeName === "ZodOptional" || fieldDef.typeName === "ZodDefault") {
      if (fieldDef.typeName === "ZodDefault") {
        fieldSchema.default = fieldDef.defaultValue();
      }
      fieldDef = fieldDef.innerType?._def || fieldDef;
    }

    // Map Zod types to JSON Schema types
    if (fieldDef.typeName === "ZodNumber") {
      fieldSchema.type = "integer";
    } else if (fieldDef.typeName === "ZodString") {
      fieldSchema.type = "string";
    } else if (fieldDef.typeName === "ZodBoolean") {
      fieldSchema.type = "boolean";
    } else if (fieldDef.typeName === "ZodArray") {
      fieldSchema.type = "array";
      fieldSchema.items = { type: "string" };
    } else if (fieldDef.typeName === "ZodObject") {
      fieldSchema.type = "object";
    }

    if (fieldDef.description || value._def.description) {
      fieldSchema.description = fieldDef.description || value._def.description;
    }

    const isOptional = value.isOptional && value.isOptional();
    if (!isOptional) {
      required.push(key);
    }

    properties[key] = fieldSchema;
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function registerTool(mcpServer, tools, title, description, schema, handler, options = {}) {
  const inputSchema = zodToJsonSchema(schema);
  const tag = options.tag || "General";

  if (!tools[tag]) tools[tag] = [];
  tools[tag].push({
    name: title,
    description,
    inputSchema,
  });

  mcpServer.tool(title, description, inputSchema, async (args) => {
    try {
      const validatedArgs = schema.parse(args);
      return await handler(validatedArgs);
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true,
      };
    }
  });
}

module.exports = { zodToJsonSchema, registerTool };
