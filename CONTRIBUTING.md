# Contribuindo

Contribuições são bem-vindas. Como cada mod roda código na máquina de quem instala, a revisão é rigorosa.

## Fluxo

1. Para algo além de um fix pequeno, abra uma issue antes e espere o aval.
2. Fork, branch a partir de `main`, um plugin por PR.
3. Valide e teste:

```bash
claude plugin validate plugins/<nome>
claude plugin test plugins/<nome>   # `bun test` direto não roda: falta o módulo da engine
```

4. Abra o PR preenchendo o checklist do template. Todo PR exige aprovação do mantenedor e checks verdes antes do merge.

## Regras que valem para todo PR

- Um plugin por recurso; o nome do plugin entra nas chaves de `$.state`.
- Hook de `tool.call` é observador: `await next()`, depois registra, dentro de `try/catch`; nunca altera o resultado.
- Sem rede, sem execução de processo e sem leitura ou escrita fora do projeto ou de `~/.claude` **sem discussão prévia na issue**. Se houver, declare no PR o que, por quê e como é limitado.
- Git sempre com `--no-optional-locks` e `-c core.fsmonitor=false`.
- Sem dependências novas sem justificativa. Sem código minificado ou ofuscado.
- Nunca commite credenciais, caminhos pessoais ou dados de sessão. Screenshots com dados reais devem ser anonimizados.
- Comentários só para o porquê não óbvio. Commits em Conventional Commits (`feat`, `fix`, `docs`...).
- Código de terceiros mantém licença e crédito originais dentro da pasta do plugin.

## Licença

Ao contribuir, você concorda que sua contribuição é licenciada sob a MIT, como o restante do repositório.

Veja também [SECURITY.md](SECURITY.md) e [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
