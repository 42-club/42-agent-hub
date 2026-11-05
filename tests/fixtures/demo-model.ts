import { randomUUID } from "node:crypto";
import type { ModelClient, ModelRequest, ModelResponse } from "42-agent";
import type { WorkerRun } from "../../server/agent-process-manager";

/** Explicit offline fixture; it still runs through core model/tool/session execution. */
export class DemoModelClient implements ModelClient {
  constructor(private readonly command: WorkerRun) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const spec = request.tools.find((tool) => tool.name === this.command.requiredTool);
    if (!spec) throw new Error("本轮缺少工具");
    return { toolCalls: [{ id: randomUUID(), name: spec.name, arguments: this.sample(spec.inputSchema) as Record<string, unknown> }] };
  }
  private sample(schema: Record<string, unknown>, field = ""): unknown {
    if (Object.hasOwn(schema, "const")) return schema.const;
    if (Array.isArray(schema.enum) && schema.enum.length) {
      const index = /target|recipient/i.test(field) ? (this.command.participant.seat + this.command.phaseVersion) % schema.enum.length : 0;
      return schema.enum[index];
    }
    const variants = schema.anyOf ?? schema.oneOf;
    if (Array.isArray(variants) && variants.length) return this.sample(variants.find((variant) => variant.type !== "null") ?? variants[0], field);
    if (schema.type === "object" || schema.properties) {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = Array.isArray(schema.required) ? schema.required as string[] : Object.keys(properties);
      return Object.fromEntries(required.map((key) => [key, this.sample(properties[key] ?? { type: "string" }, key)]));
    }
    if (schema.type === "array") return Array.from({ length: typeof schema.minItems === "number" ? schema.minItems : 1 }, () => this.sample((schema.items ?? { type: "string" }) as Record<string, unknown>));
    if (schema.type === "boolean") return false;
    if (schema.type === "integer" || schema.type === "number") return typeof schema.minimum === "number" ? schema.minimum : 1;
    if (schema.type === "null") return null;
    if (/content|message|text|reason/i.test(field)) {
      const lines = ["我倾向先明确判断标准，再比较各自的理由。", "我注意到几位的描述还有差异，想再听一轮具体解释。", "我的判断会结合前面的发言，也保留修正的空间。", "我会关注行动和发言是否一致，并给其他人解释的机会。"];
      return `【离线示例】${lines[(this.command.participant.seat + this.command.phaseVersion) % lines.length]}`;
    }
    return "public";
  }
}
