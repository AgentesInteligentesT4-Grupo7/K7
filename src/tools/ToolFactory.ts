import { CreateFileTool } from './impl/CreateFileTool.js';
import { CurrentDateTimeTool } from './impl/CurrentDateTimeTool.js';
import { ListFilesTool } from './impl/ListFilesTool.js';
import { ReadFileTool } from './impl/ReadFileTool.js';
import { ToolRegistry } from './ToolRegistry.js';
import { WorkspaceSandbox } from './WorkspaceSandbox.js';

export interface ToolFactoryOptions {
  /** Módulo "arquivos": criar, ler e listar arquivos no workspace. */
  files: boolean;
}

/** Instancia as ferramentas do núcleo e dos módulos ligados e as registra no `ToolRegistry`. */
export class ToolFactory {
  constructor(
    private readonly workspaceDir: string,
    private readonly options: ToolFactoryOptions = { files: true },
  ) {}

  createRegistry(): ToolRegistry {
    const registry = new ToolRegistry().register(new CurrentDateTimeTool());
    if (this.options.files) {
      const sandbox = new WorkspaceSandbox(this.workspaceDir);
      sandbox.ensureRoot();
      registry.register(new CreateFileTool(sandbox)).register(new ReadFileTool(sandbox)).register(new ListFilesTool(sandbox));
    }
    return registry;
  }
}
