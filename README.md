# SN - Leituras • Residencial Campos do Sul

Aplicativo Web Progressivo (**PWA**) mobile-first para coleta mensal de **Água e Gás** nas **28 torres (560 apartamentos por serviço)** do **Residencial Campos do Sul**.

Projetado como piloto independente do *Leitura Fácil*, operando 100% em arquitetura **Cache-First sobre IndexedDB** com carimbo de auditoria nas fotos, backup/restauração local `.zip` por torre, relatórios A4 em preto e branco e sincronização incremental explícita para coleta simultânea em dupla via **Firebase Authentication (Google) + Cloud Firestore `(default)`**.

---

## Arquitetura e Garantias

- **Condomínio Único**: 28 torres (`01` a `28`), 20 apartamentos por torre (`101` ao `504`, quatro por andar), totalizando **560 unidades de Água** e **560 unidades de Gás**.
- **Piloto Local e Modo Treinamento Isolado**:
  - O **Piloto Local** começa vazio no banco IndexedDB principal (`sn_leituras_prod_db`), funciona sem Firebase, sem API Gemini, sem OCR e sem servidor Node em produção.
  - O **Modo Treinamento** é acessível apenas no menu da tela inicial e utiliza um banco IndexedDB totalmente separado (`sn_leituras_training_db`).
- **Zero Leituras Automáticas no Firestore**:
  - Navegação entre torres e apartamentos, digitação de leitura, cálculo de consumo/alerta, captura e carimbo de foto, download de JPEG, backup ZIP e geração de relatórios CSV/PDF A4 consomem **zero leituras no Firestore**.
  - O envio da fila (`syncQueue`) grava diretamente (`setDoc` / `updateDoc`) **sem leitura prévia por item**, delegando a validação de revisão (`revision` e `baseRevisionToken`) às regras de segurança (`firestore.rules`).
  - O botão explícito **Atualizar** busca exclusivamente o delta de **Configurações**, **Referências (incluindo reimportações de CSV)** e **Leituras** usando o cursor composto completo do servidor (`{ seconds, nanoseconds, docId }`), sem reduzir para milissegundos.

---

## Como Conectar o Projeto Firebase Piloto e Publicar na Vercel (`sn-leituras.vercel.app`)

### 1. Variáveis de Ambiente (`.env` / Painel da Vercel)

Copie `.env.example` para `.env` (ou cadastre em **Project Settings → Environment Variables** na Vercel):

```dotenv
VITE_FIREBASE_API_KEY="AIza..."
VITE_FIREBASE_AUTH_DOMAIN="seu-projeto-piloto.firebaseapp.com"
VITE_FIREBASE_PROJECT_ID="seu-projeto-piloto"
VITE_FIREBASE_STORAGE_BUCKET="seu-projeto-piloto.firebasestorage.app"
VITE_FIREBASE_MESSAGING_SENDER_ID="1234567890"
VITE_FIREBASE_APP_ID="1:1234567890:web:abcdef"
VITE_FIREBASE_DATABASE_ID="(default)"
```

### 2. Autorizar o Domínio no Firebase Authentication

1. No Console do Firebase do projeto piloto, acesse **Authentication → Sign-in method** e habilite o provedor **Google**.
2. Em **Authentication → Settings → Authorized domains**, adicione o domínio de produção da Vercel:
   - `sn-leituras.vercel.app`

### 3. Cadastrar os Dois UIDs Autorizados nas Regras do Firestore (`firestore.rules`)

1. Cada um dos dois leituristas abre o app e toca em **Entrar com Google (Coleta em Dupla)**.
2. Após o primeiro login, o aplicativo exibe na tela inicial o `UID` autenticado com o botão **Copiar meu UID** (também visível no painel **Firebase Console → Authentication → Users**).
3. No arquivo `firestore.rules`, substitua os placeholders `'UID_LEITURISTA_1'` e `'UID_LEITURISTA_2'` pelos dois UIDs reais:

```javascript
function isAuthorizedReader() {
  return isSignedIn()
    && request.auth.token.email_verified == true
    && (request.auth.uid in ['UID_REAL_LEITURISTA_1', 'UID_REAL_LEITURISTA_2']);
}
```

4. Publique as regras no console do Firebase (**Firestore Database → Rules → Publish**). Até que os UIDs reais sejam cadastrados, o acesso aos dados compartilhados permanece bloqueado por padrão.

### 4. Build Estático na Vercel

- **Framework Preset**: `Vite`
- **Build Command**: `npm run build`
- **Output Directory**: `dist`

---

## Roteiro de Aceite no Celular (5 Etapas + Teste em Dupla)

1. **Importação de CSV de Gás e Caso Homologado (`266,8440 − 266,0070 = 0,8370 m³`)**:
   - Na tela inicial (**Torres**), selecione **Gás** e toque em **Carregar CSV Homologado de Gás** (ou abra **Gestão → Importar CSV de Ponto de Partida**, escolha serviço **Gás** e ciclo ativo e importe seu CSV `Bloco;Apartamento;Anterior;Atual`).
   - Abra **Torre 01 → Apto 303**. Confira que **Anterior** exibe `266,0070 m³`.
   - Digite `266,8440` (com vírgula ou ponto) em **Leitura atual** e confira o cálculo imediato: **Consumo `0,8370 m³`** sem alerta.
2. **Alertas Imediatos e 2ª Foto de Validação**:
   - Em qualquer apartamento com referência anterior, digite um valor **menor que a anterior** (ex.: `265,5000` no Apto 303): o alerta de leitura negativa aparece imediatamente durante a digitação, exigindo justificativa na **Observação** e desbloqueando a **2ª Foto (Validação)**.
   - Digite um valor com consumo **acima do limite** (`> 15 m³` no Gás ou `> 22 m³` na Água): o alerta de consumo elevado aparece imediatamente e exige justificativa + 2ª foto.
   - Marque **Medidor novo ou trocado** para verificar que o consumo distorcido é excluído da soma da torre.
3. **Modo Avião, Câmera com Carimbo, Persistência e Retomada**:
   - Ative o **Modo Avião** no celular.
   - No Apto 303 (`266,8440`), pressione `Enter` no teclado (ou toque em **Tirar Foto do Medidor**), capture a foto e confira o carimbo na barra inferior da imagem com condomínio, torre, apartamento, serviço, valor final, data/hora e código de auditoria.
   - Se alterar o valor digitado após a foto, toque em **Salvar e avançar**: o app regera o carimbo com o valor final correto antes de gravar no IndexedDB e só avança para o próximo apartamento após confirmar a gravação local.
   - Feche completamente o navegador/PWA em modo avião e reabra: confira que o valor, observação, fotos e o status **Salva no aparelho** permanecem intactos (e que qualquer rascunho não salvo oferece retomada imediata no topo).
4. **Download do JPEG, Backup ZIP da Torre e Restauração Idempotente**:
   - Na tela de leitura, toque em **Baixar foto** ao lado da prévia para salvar o JPEG nomeado (`YYYYMMDD_HHMMSS_T01_A303_GAS_F1.jpg`).
   - Na lista da **Torre 01**, toque em **Backup da torre** para baixar o arquivo `.zip` (contendo `manifest.json`, `photos/*.jpg` e `relatorio_conferencia.csv`).
   - Em outro perfil/aparelho (ou após limpar os dados), abra **Gestão → Backup ZIP & Restauração**, selecione o `.zip` e restaure: as mesmas leituras e fotos são recuperadas localmente.
   - Reabra o **mesmo arquivo ZIP**: a prévia identifica todas as leituras como **Duplicatas idênticas** e restaura `0` registros, sem duplicar leituras nem sobrescrever fotos.
5. **Consistência entre Coleta, Gestão e PDF A4 P&B + Teste em Dupla**:
   - Abra **Gestão → Revisão, Conflitos & Relatórios**, filtre pela **Torre 01** e exporte o **PDF A4 P&B**: confirme que a tabela da Gestão e o PDF A4 mostram exatamente o mesmo consumo (`0,8370 m³`) e incluem as miniaturas em preto e branco das fotos das leituras com alerta.
   - **Teste em Dupla (2 Celulares + 2 Contas Google)**:
     - Celular A importa o CSV e toca em **Atualizar**. Celular B toca em **Atualizar** e recebe todas as referências.
     - Celular A coleta o Apto `101` e Celular B coleta o Apto `102`; após ambos tocarem em **Atualizar**, os dois veem ambas as leituras com suas respectivas autorias (`Todas as leituras` / `Minhas leituras`).
     - Em **Modo Avião**, ambos coletam o mesmo apartamento (ex.: Apto `103`) com valores e fotos diferentes. Ao reconectar e tocar em **Atualizar**, o primeiro sincroniza (`revision: 1`) e o segundo tem a gravação bloqueada pela regra de revisão do Firestore, preservando automaticamente a versão sincronizada e a tentativa local com suas fotos sob o status **Conflito** para conferência lado a lado.
     - Se o Celular A reimportar um CSV corrigindo uma referência e tocar em **Atualizar**, o Celular B recebe a nova referência no delta ao tocar em **Atualizar**, preservando as leituras já coletadas e recalculando os consumos locais.
