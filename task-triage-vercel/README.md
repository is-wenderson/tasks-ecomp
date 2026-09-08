# Central de Triagem — implantação

Arquitetura final:

`Navegador -> Vercel (/api/backend) -> Google Apps Script -> Google Sheets + Anthropic`

## 1. Criar a planilha e o Apps Script

1. Crie uma nova planilha no Google Sheets.
2. Na planilha, abra **Extensões > Apps Script**.
3. Substitua o conteúdo do arquivo `Code.gs` pelo `Code.gs` fornecido.
4. Em **Configurações do projeto > Propriedades do script**, crie:
   - `ANTHROPIC_API_KEY`: sua chave da Anthropic.
   - `APP_ACCESS_KEY`: uma senha longa/aleatória interna. Exemplo: gere uma string de 32+ caracteres. Não use a mesma senha do site.
   - `AI_MODEL`: opcional. Se não definir, o código usa `claude-sonnet-4-6`.
5. No editor, execute manualmente a função `setupProject()` uma vez e autorize o script.
6. Confirme que foi criada a aba `Tarefas`.

## 2. Publicar o Apps Script como Web App

1. No Apps Script, clique **Implantar > Nova implantação**.
2. Tipo: **Aplicativo da Web / Web app**.
3. Executar como: **você**.
4. Acesso: **qualquer pessoa / Anyone** (quando essa opção estiver disponível na sua conta).
5. Implante e copie a URL que termina em `/exec`.

> Não coloque a URL `/dev` no Vercel. Use a URL da implantação `/exec`.

## 3. Publicar no Vercel

A pasta que deve ir para o Vercel é `task-triage-vercel`, contendo:

- `index.html`
- `api/backend.mjs`

No projeto do Vercel, crie estas Environment Variables:

- `APPS_SCRIPT_URL`: URL `/exec` da implantação do Apps Script.
- `APPS_SCRIPT_ACCESS_KEY`: exatamente o mesmo valor usado em `APP_ACCESS_KEY` no Apps Script.
- `SITE_PASSWORD`: opcional. Se definir, o site pedirá essa senha antes de permitir operações. Essa pode ser uma senha mais fácil de digitar; ela não é enviada ao Apps Script.

Depois, faça um novo deploy.

## 4. Teste rápido depois de publicar

1. Abra o endereço do Vercel em uma janela anônima.
2. Crie uma tarefa manual.
3. Atualize a página: a tarefa deve continuar aparecendo.
4. Edite a tarefa e atualize novamente.
5. Marque como concluída e reabra.
6. Exclua uma tarefa.
7. Digite um relato no campo de IA e clique **Analisar e organizar**.
8. Confira no Google Sheets:
   - a aba `Tarefas` deve conter as tarefas;

## Segurança

- A chave `ANTHROPIC_API_KEY` fica somente no Apps Script.
- `APP_ACCESS_KEY` fica no Apps Script e no ambiente do Vercel, nunca no `index.html`.
- A URL do Apps Script fica somente no ambiente do Vercel.
- `SITE_PASSWORD` é opcional e fica somente no ambiente do Vercel; o navegador envia essa senha à Function do mesmo domínio.
- Não coloque nenhuma dessas chaves diretamente no HTML ou em um repositório público.

## Observação

Se o Apps Script estiver em uma conta Google Workspace cuja política não permita Web Apps públicos, a opção “Anyone” pode não aparecer. Nesse caso, a implantação precisa ser adaptada à política da organização.
