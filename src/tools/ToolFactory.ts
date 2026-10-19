import { CreateFileTool } from './impl/CreateFileTool.js';
import { CurrentDateTimeTool } from './impl/CurrentDateTimeTool.js';
import { ListFilesTool } from './impl/ListFilesTool.js';
import { ReadFileTool } from './impl/ReadFileTool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { WorkspaceSandbox } from './WorkspaceSandbox.js';

/** Instancia o conjunto padrão de ferramentas e as registra no `ToolRegistry`. */
export class ToolFactory {
  constructor(private readonly workspaceDir: string) {}

  createRegistry(): ToolRegistry {
    const sandbox = new WorkspaceSandbox(this.workspaceDir);
    sandbox.ensureRoot();
    return new ToolRegistry()
      .register(new CurrentDateTimeTool())
      .register(new CreateFileTool(sandbox))
      .register(new ReadFileTool(sandbox))
      .register(new ListFilesTool(sandbox));
  }
}
