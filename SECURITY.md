# Segurança

Os mods deste repositório rodam código local em hooks de `tool.call` e leem estado do Claude Code (arquivos do projeto, histórico de sessões em `~/.claude/projects`). Um bug aqui pode expor dados ou executar código na máquina de quem instala.

## Reportar uma vulnerabilidade

Não abra issue pública. Use o **Private Vulnerability Reporting** do GitHub: aba *Security* → *Report a vulnerability*.

Inclua o plugin, a versão, os passos para reproduzir e o impacto. Resposta inicial em até 7 dias; correção ou plano em até 30.

## Escopo

Vale: execução de código ou comando inesperado, leitura ou escrita fora do esperado, vazamento de credenciais, bypass das proteções documentadas (mascaramento no `recall`, git sem fsmonitor no `filetree`).

Fora do escopo: comportamento da engine de mods do Claude Code em si (reporte à Anthropic) e plugins de terceiros.

## Versões suportadas

Apenas a última versão de cada plugin no branch `main`.
