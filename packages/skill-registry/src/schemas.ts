import {
  array,
  object,
  optional,
  string,
} from 'valibot'

const toolRefSchema = object({
  name: string(),
  description: optional(string()),
})

const allowListRefSchema = object({
  networks: optional(array(string())),
  filesystemWrites: optional(array(string())),
  shellCommands: optional(array(string())),
})

export const skillManifestSchema = object({
  id: string(),
  name: string(),
  description: string(),
  triggers: array(string()),
  tools: optional(array(toolRefSchema)),
  allowed: optional(allowListRefSchema),
})
