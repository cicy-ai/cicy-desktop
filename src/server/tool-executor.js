const { loadToolCatalog } = require("./tool-catalog");

function getToolRecord(name) {
  const toolCatalog = loadToolCatalog();
  const record = toolCatalog.toolsByName.get(name);
  if (!record) {
    throw new Error(`Tool '${name}' not found`);
  }

  return { toolCatalog, record };
}

async function executeTool(name, args = {}, context = {}) {
  const { record } = getToolRecord(name);
  const validatedArgs = record.schema.parse(args || {});
  return record.handler(validatedArgs, context);
}

module.exports = {
  executeTool,
  getToolRecord,
};
