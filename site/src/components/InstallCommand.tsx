import { Terminal } from 'lucide-react';
import { project, ui } from '../content/site';
import { CopyButton } from './CopyButton';

export function InstallCommand() {
  return <div className="install-command"><Terminal size={16} aria-hidden="true" /><code>{project.install}</code><CopyButton value={project.install} label={ui.install} /></div>;
}
