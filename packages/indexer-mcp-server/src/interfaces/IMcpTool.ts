export interface IMcpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;

  execute(params: Record<string, unknown>): Promise<unknown>;
}
