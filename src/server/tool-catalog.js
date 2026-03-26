function buildToolCatalog(toolModules) {
  const toolsByName = new Map();
  const toolsByTag = {};

  toolModules.forEach((module) => {
    module((name, description, schema, handler, options = {}) => {
      const tag = options.tag || "General";
      const record = {
        name,
        description,
        schema,
        handler,
        options,
        tag,
      };

      toolsByName.set(name, record);
      if (!toolsByTag[tag]) toolsByTag[tag] = [];
      toolsByTag[tag].push(record);
    });
  });

  return {
    toolsByName,
    toolsByTag,
  };
}

function loadToolCatalog() {
  delete require.cache[require.resolve("../tools")];
  const toolModules = require("../tools");
  return buildToolCatalog(toolModules);
}

function listToolDefinitions(toolCatalog, mapToolDefinition) {
  return Object.entries(toolCatalog.toolsByTag).reduce((acc, [tag, toolList]) => {
    acc[tag] = toolList.map((tool) => mapToolDefinition(tool));
    return acc;
  }, {});
}

module.exports = {
  buildToolCatalog,
  loadToolCatalog,
  listToolDefinitions,
};
