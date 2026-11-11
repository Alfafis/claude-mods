## O que muda

<!-- Plugin afetado e resumo. Um plugin por PR. -->

## Checklist de segurança

- [ ] Acessa rede? (se sim, explique e referencie a issue aprovada)
- [ ] Executa processos? (comando, argumentos, de onde vêm)
- [ ] Lê ou escreve fora do projeto ou de `~/.claude`?
- [ ] Adiciona dependência ou código de terceiros?
- [ ] Nenhuma credencial, caminho pessoal ou dado de sessão no diff nem em screenshots

## Validação

- [ ] `claude plugin validate plugins/<nome>`
- [ ] `claude plugin test plugins/<nome>`
- [ ] Testei o mod rodando localmente
