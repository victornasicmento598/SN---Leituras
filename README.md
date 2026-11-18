# SN - Leituras • Residencial Campos do Sul

Aplicativo Web Progressivo (**PWA**) mobile-first para coleta mensal de **Água e Gás** nas **28 torres (560 apartamentos por serviço)** do **Residencial Campos do Sul**.

Projetado como piloto independente do *Leitura Fácil*, operando 100% em arquitetura **Cache-First sobre IndexedDB** com cálculo ao vivo em `m³` e `R$`, carimbo colorido de auditoria de 4 linhas nas fotos, backup/restauração local `.zip` por torre, relatórios **PDF A4 Coloridos** (por torre/serviço e consolidado do ciclo com 1ª e 2ª fotos) e sincronização incremental explícita para coleta simultânea em dupla via **Firebase Authentication (Google) + Cloud Firestore `(default)`**.

---

## Arquitetura e Garantias

- **Condomínio Único**: 28 torres (`01` a `28`), 20 apartamentos por torre (`101` ao `504`, quatro por andar), totalizando **560 unidades de Água** e **560 unidades de Gás**.
- **Piloto Local e Modo Treinamento Isolado**:
  - O **Piloto Local** começa vazio no banco IndexedDB principal (`sn_leituras_prod_db`), funciona sem Firebase, sem API Gemini, sem OCR e sem servidor Node em produção.
  - O **Modo Treinamento** é acessível apenas no menu da tela inicial e utiliza um banco IndexedDB totalmente separado (`sn_leituras_training_db`).
- **Tarifas (`R$/m³`) e Valores Auditados (`R$`)**:
  - Um novo ciclo inicia sem tarifas cadastradas (`waterTariffPerM3: null`, `gasTariffPerM3: null`), exibindo `Sem tarifa configurada` e mantendo o valor em `R$` indisponível até que o gestor cadastre as tarifas em **Gestão → Tarifas (R$/m³) & Limites de Alerta**.
  - Na coleta em campo, enquanto o leiturista digita, o app calcula imediatamente o consumo em `m³` e o valor em `R$` (`consumo × tarifa aplicável`, com arredondamento monetário de 2 casas decimais).
  - Em caso de ausência de tarifa, ausência de leitura anterior, troca de medidor ou consumo negativo, o app exibe o motivo explícito (`Sem tarifa configurada`, `Sem leitura anterior`, `Troca de medidor (consumo excluído)`, `Consumo negativo (em revisão)`) e deixa o valor em `R$` indisponível.
  - Cada leitura salva persiste o snapshot auditado (`appliedTariff`, `calculatedAmountBrl`, `amountUnavailableReason`) e grava a tarifa e o valor em `R$` também na **marca d’água colorida de 4 linhas da própria foto**. Alterações posteriores de tarifa na Gestão preservam os valores já auditados por padrão e oferecem um botão explícito para **Recalcular leituras já salvas com a nova tarifa** (atualizando as fotos no IndexedDB e reenfileirando no delta).
- **PDF A4 Colorido (Por Torre/Serviço e Consolidado do Ciclo) sem Omissão Silenciosa**:
  - Mantém a exportação por torre e serviço e inclui a opção **PDF Único Consolidado Colorido (1ª e 2ª Fotos)** organizado por **Serviço → Torre → Apartamento**, com subtotais por torre e totais por serviço (`m³` e `R$`).
  - Inclui **todas as fotos coloridas vinculadas** (1ª foto obrigatória e 2ª foto de validação quando houver, para leituras normais e com alerta), lendo exclusivamente do **IndexedDB** em streaming sequencial com barra de progresso ao vivo e liberação imediata de memória a cada foto para suportar grandes volumes no celular sem omitir nenhuma imagem.
- **Zero Leituras Automáticas no Firestore**:
  - Navegação entre torres e apartamentos, digitação de leitura, cálculo de consumo/valor em `R$`/alerta, captura e carimbo de foto, download de JPEG, backup ZIP e geração de relatórios CSV/PDF A4 Colorido consomem **zero leituras no Firestore**.
  - O envio da fila (`syncQueue`) grava diretamente (`setDoc` / `updateDoc`) **sem leitura prévia por item**, delegando a validação de revisão (`revision` e `baseRevisionToken`) às regras de segurança (`firestore.rules`).
  - O botão explícito **Atualizar** busca exclusivamente o delta de **Configurações (incluindo tarifas)**, **Referências (incluindo reimportações de CSV)** e **Leituras** usando o cursor composto completo do servidor (`{ seconds, nanoseconds, docId }`), sem reduzir para milissegundos.

---

## Como Conectar o Projeto Firebase Piloto (`sn-leituras-piloto`) e Publicar na Vercel (`sn-leituras.vercel.app`)

### 1. Variáveis de Ambiente (`.env` / Painel da Vercel)

Copie `.env.example` para `.env` (ou cadastre em **Project Settings → Environment Variables** na Vercel):

```dotenv
VITE_FIREBASE_API_KEY="AIza..."
VITE_FIREBASE_AUTH_DOMAIN="sn-leituras-piloto.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="sn-leituras-piloto"
VITE_FIREBASE_STORAGE_BUCKET="sn-leituras-piloto.firebasestorage.app"
VITE_FIREBASE_MESSAGING_SENDER_ID="1234567890"
VITE_FIREBASE_APP_ID="1:1234567890:web:abcdef"
VITE_FIREBASE_DATABASE_ID="(default)"
```

### 2. Autorizar o Domínio no Firebase Authentication

1. No Console do Firebase do projeto `sn-leituras-piloto`, acesse **Authentication → Sign-in method** e habilite o provedor **Google**.
2. Em **Authentication → Settings → Authorized domains**, adicione o domínio de produção da Vercel:
   - `sn-leituras.vercel.app`

### 3. Cadastrar os Dois UIDs Autorizados nas Regras do Firestore (`firestore.rules`)

1. Cada um dos dois leituristas abre o app e toca em **Entrar com Google (Coleta em Dupla)**.
2. Após o primeiro login, o aplicativo exibe na tela inicial o `UID` autenticado com o botão **Copiar meu UID**.
3. No arquivo `firestore.rules`, substitua os placeholders `'UID_LEITURISTA_1'` e `'UID_LEITURISTA_2'` pelos dois UIDs reais e publique as regras no console do Firebase.

---

## 1. Roteiro de Aceite de Campo no Celular (Offline-First)

1. **Início sem Tarifa e Caso Homologado (`266,8440 − 266,0070 = 0,8370 m³`)**:
   - Na tela inicial (**Torres**), selecione **Gás** e toque em **Carregar CSV Homologado de Gás**.
   - Abra **Torre 01 → Apto 303**. Confira que **Anterior** exibe `266,0070 m³`.
   - Digite `266,8440` (com vírgula ou ponto) em **Leitura atual**: confira o cálculo imediato de **Consumo `0,8370 m³`** e veja que o bloco **Valor Calculado (R$)** informa `Sem tarifa configurada` enquanto a tarifa ainda não foi cadastrada na Gestão.
2. **Cálculo ao Vivo em Reais (`R$`) e Carimbo Colorido na Foto**:
   - Após configurar as tarifas na Gestão (ex.: Água `R$ 6,5000/m³` e Gás `R$ 32,8000/m³`) ou receber via **Atualizar**, volte ao **Torre 01 → Apto 303 (Gás)** com `266,8440`: confira que o consumo `0,8370 m³` exibe imediatamente **Tarifa aplicada: `R$ 32,8000/m³`** e **Valor Calculado: `R$ 27,45`**.
   - Pressione `Enter` (ou toque em **Tirar Foto do Medidor** / **Simular Foto**) e verifique que a foto preserva 100% das cores originais do medidor e inclui no carimbo inferior de 4 linhas a leitura (`266,8440 m³`), a anterior (`266,0070 m³`), o consumo (`0,8370 m³`), a tarifa (`R$ 32,8000/m³`) e o valor (`R$ 27,45`).
3. **Alertas Imediatos, Troca de Medidor, Consumo Negativo e 2ª Foto Colorida**:
   - Digite um valor **menor que a anterior** (ex.: `265,5000`): o alerta de leitura negativa aparece imediatamente, o valor em `R$` fica indisponível com o motivo `Consumo negativo (em revisão)`, e o app exige justificativa na **Observação** + **2ª Foto (Validação)**.
   - Marque **Medidor novo ou trocado**: o consumo e o valor em `R$` ficam indisponíveis com o motivo `Troca de medidor (consumo excluído)`, excluindo a unidade da soma da torre.
4. **Modo Avião, Persistência Local e PDF A4 Colorido da Torre no Celular**:
   - Em **Modo Avião**, salve a leitura e volte para a lista de apartamentos da **Torre 01**: confira que o cartão do apartamento exibe a leitura em `m³`, a variação `Δ m³`, o valor em `R$` e o selo **Salva no aparelho**.
   - Toque em **PDF A4 Colorido** no topo da lista da torre: acompanhe o indicador de progresso e confirme que o PDF A4 gerado offline contém todas as fotos coloridas (1ª e 2ª) sem omissões.

---

## 2. Roteiro de Aceite da Gestão no Computador (Auditoria, Tarifas e PDF Consolidado)

1. **Cadastro de Tarifas (`R$/m³`), Preservação de Valores Auditados e Recálculo Explícito**:
   - Abra **Gestão → Tarifas (R$/m³) & Limites de Alerta**, cadastre as tarifas de Água e Gás do ciclo e clique em **Salvar Tarifas (R$/m³) e Limites (Preservando Leituras Já Salvas)**.
   - Verifique que leituras salvas anteriormente mantêm seus valores auditados originais (`appliedTariff` e `calculatedAmountBrl`).
   - Se desejar aplicar uma correção de tarifa às leituras já salvas, clique no botão explícito **Recalcular X leitura(s) com a tarifa atual**: confirme que os registros e os carimbos das fotos são atualizados no IndexedDB e enfileirados para o próximo **Atualizar**.
2. **Teste Integrado com 2 Torres (`01` e `02`), Ambos os Serviços (Água e Gás), Fotos Normais/Alerta e Simetria 100%**:
   - Em **Gestão → Revisão, Conflitos & Relatórios (CSV / PDF Colorido)**, clique em **Executar Teste 2 Torres (Água + Gás + Fotos 1ª/2ª) e Conferir Simetria**.
   - Confira a tabela de conferência cruzada gerada na tela comprovando que as 8 leituras nas Torres 01 e 02 (Água e Gás, normais com 1 foto e alertas/exceções com 1ª e 2ª fotos) apresentam exatamente os mesmos valores de `m³`, tarifa (`R$/m³`) e `R$` na **Coleta**, no **Carimbo da Foto**, no **CSV Exportado** e no **PDF Colorido**.
3. **Exportação do PDF A4 Colorido Consolidado do Ciclo**:
   - Na barra de exportação da Gestão, selecione **Água + Gás (2 serviços)** e clique em **PDF Único Consolidado Colorido (1ª e 2ª Fotos)**.
   - Acompanhe a barra de progresso ao vivo e abra o PDF A4 gerado: confirme a organização por **Serviço → Torre → Apartamento**, os totais por serviço (`m³` e `R$`), os subtotais por torre e a presença de todas as 1ª e 2ª fotos coloridas com mostrador e marca d’água legíveis.
