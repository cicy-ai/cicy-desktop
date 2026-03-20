#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// 从服务器获取工具列表和 schemas
async function getToolsWithSchemas() {
  const http = require('http');
  const tokenPath = path.join(require('os').homedir(), 'global.json');
  const config = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
  const token = config.api_token || '';
  
  // 获取工具列表
  const tools = await new Promise((resolve, reject) => {
    http.get('http://localhost:8101/rpc/tools', {
      headers: { Authorization: `Bearer ${token}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data).tools));
    }).on('error', reject);
  });
  
  // 获取 schemas
  const schemas = await new Promise((resolve, reject) => {
    http.get('http://localhost:8101/rpc/schemas', {
      headers: { Authorization: `Bearer ${token}` }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(JSON.parse(data).schemas));
    }).on('error', reject);
  });
  
  return tools.map(tool => ({
    ...tool,
    schema: schemas[tool.name] || { type: 'object' }
  }));
}

async function generateOpenAPI() {
  const tools = await getToolsWithSchemas();
  
  const openapi = {
    openapi: '3.0.0',
    info: {
      title: 'CiCy Desktop REST API',
      version: '1.0.0',
      description: `REST API for CiCy Desktop tools - ${tools.length} tools available`,
    },
    servers: [
      {
        url: 'http://localhost:8101',
        description: 'Local server',
      },
      {
        url: 'https://gcp-8101.cicy.de5.net',
        description: 'Remote server',
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'token',
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {}
  };

  // 添加 /rpc/tools 端点
  openapi.paths['/rpc/tools'] = {
    get: {
      summary: 'List all available tools',
      tags: ['Tools'],
      security: [{ bearerAuth: [] }],
      responses: {
        200: {
          description: 'List of tools',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  tools: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        name: { type: 'string' },
                        description: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  // 为每个工具生成端点
  for (const tool of tools) {
    openapi.paths[`/rpc/${tool.name}`] = {
      post: {
        description: tool.description,
        tags: ['Tools'],
        security: [{ bearerAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: tool.schema
            }
          }
        },
        responses: {
          200: {
            description: 'Tool execution result',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    content: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          type: { type: 'string' },
                          text: { type: 'string' }
                        }
                      }
                    }
                  }
                }
              }
            }
          },
          404: { description: 'Tool not found' },
          500: { description: 'Execution error' }
        }
      }
    };
  }

  // 保存为 YAML
  const yamlContent = yaml.dump(openapi, { lineWidth: -1 });
  fs.writeFileSync('openapi.yml', yamlContent);
  console.log('✅ Generated: openapi.yml');
}

generateOpenAPI().catch(console.error);
