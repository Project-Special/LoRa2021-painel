# LoRa2021 — painel

Painel web da bancada **LoRa2021** (Semtech LR2021), publicado no GitHub
Pages: https://project-special.github.io/LoRa2021-painel/

Este repositório tem **só a página**. O firmware mora num repositório
privado, e é de lá que estes arquivos vêm, copiados por
`tools/publica_painel.py` — não edite aqui, a próxima publicação sobrescreve.

Na placa a mesma página é servida pelo próprio ESP32 (ponto de acesso
`LoRa2021-…`). Aqui, publicada, a aba **Banco de dados** pede a URL e a chave
do Supabase no formulário e as guarda **só no navegador**: nenhuma credencial
entra neste repositório.
