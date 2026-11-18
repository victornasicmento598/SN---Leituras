# Especificação de Segurança Firestore — SN - Leituras (Phase 0 TDD)

## 1. Data Invariants (Invariantes de Segurança)

1. **Lista Fixa de Dois UIDs Autorizados**: Apenas os dois leituristas autorizados na lista fixa (`request.auth.uid in ['UID_LEITURISTA_1', 'UID_LEITURISTA_2']`) com e-mail Google verificado (`request.auth.token.email_verified == true`) têm permissão de leitura ou gravação nos caminhos compartilhados `/cycles/{cycleId}/settings/{docId}`, `/cycles/{cycleId}/references/{docId}` e `/cycles/{cycleId}/readings/{docId}`. Enquanto os placeholders `'UID_LEITURISTA_1'` e `'UID_LEITURISTA_2'` não forem substituídos pelos UIDs reais do painel Firebase Authentication, o acesso aos dados compartilhados permanece bloqueado.
2. **Integridade de Identidade e Autoria**:
   - Na criação (`create`) de qualquer leitura (`readings`), `createdByUid == request.auth.uid` e `updatedByUid == request.auth.uid`.
   - Na atualização (`update`) de qualquer leitura (`readings`), os campos `createdByUid`, `createdByName`, `createdAt`, `id`, `condominiumId`, `cycleId`, `service`, `tower` e `apartment` são imutáveis (`incoming().field == existing().field`), enquanto `updatedByUid == request.auth.uid`.
3. **Integridade de Tarifas (`R$/m³`) e Valores Auditados (`R$`)**:
   - `CycleSettings` valida `waterTariffPerM3` e `gasTariffPerM3` (`>= -1 && <= 10000`) acompanhados das flags booleanas `hasWaterTariff` e `hasGasTariff`.
   - `MeterReading` valida o snapshot auditado `appliedTariff` (`>= -1 && <= 10000`), `hasAppliedTariff`, `calculatedAmountBrl` (`>= -1 && <= 9999999`), `hasCalculatedAmountBrl` e `amountUnavailableReason` (`size() <= 120`).
4. **Proteção de Revisão Sem Leitura Prévia**:
   - Criação (`create`): exige `incoming().revision == 1` e `incoming().baseRevisionToken == ""`.
   - Atualização (`update`): exige `incoming().revision == existing().revision + 1`, `incoming().baseRevisionToken == existing().revisionToken` e `incoming().revisionToken != existing().revisionToken`. Isso garante que uma tentativa offline baseada em revisão antiga seja rejeitada pelas regras com `PERMISSION_DENIED`, permitindo ao cliente preservar ambas as versões em conflito.
5. **Integridade Temporal do Cursor do Servidor**:
   - Em todas as gravações (`create` e `update`), `incoming().serverUpdatedAt == request.time`. Timestamps arbitrários forjados pelo cliente são rejeitados.
6. **Proteção de Volume ("Denial of Wallet" & Limite de 1MB do Documento)**:
   - Todos os campos `string` possuem limite estrito de `.size()`. Cada uma das duas fotos carimbadas (`photo1DataUrl`, `photo2DataUrl`) é limitada a `<= 380000` caracteres (~370 KB cada, totalizando <= 760 KB para ambas com folga para metadados abaixo de 1 MB).

---

## 2. The "Dirty Dozen" Adversarial Payloads

1. **Payload 1 (Unauthenticated Write)**: `request.auth == null` tentando gravar em `/cycles/2026-11/readings/2026-11_gas_T01_A303` -> `PERMISSION_DENIED`.
2. **Payload 2 (Unauthorized UID)**: `request.auth.uid == 'attacker_uid_999'` tentando ler ou gravar em `/cycles/2026-11/readings/2026-11_gas_T01_A303` -> `PERMISSION_DENIED`.
3. **Payload 3 (Unverified Email Spoof)**: `request.auth.uid == 'UID_LEITURISTA_1'` mas `email_verified == false` -> `PERMISSION_DENIED`.
4. **Payload 4 (Author Spoofing on Create)**: `UID_LEITURISTA_1` enviando `createdByUid: 'UID_LEITURISTA_2'` em um `create` -> `PERMISSION_DENIED`.
5. **Payload 5 (Original Author Overwrite on Update)**: `UID_LEITURISTA_2` alterando `createdByUid` ou `createdByName` durante um `update` -> `PERMISSION_DENIED`.
6. **Payload 6 (Stale Revision / Offline Collision)**: `UID_LEITURISTA_2` enviando `update` com `revision: 2` e `baseRevisionToken: 'rev_1'` quando o servidor já está em `revision: 2, revisionToken: 'rev_2'` -> `PERMISSION_DENIED`.
7. **Payload 7 (Revision Jump Attack)**: `UID_LEITURISTA_1` criando leitura com `revision: 5` em vez de `revision: 1` -> `PERMISSION_DENIED`.
8. **Payload 8 (Forged Server Timestamp)**: Cliente enviando `serverUpdatedAt` diferente de `request.time` para corromper o cursor incremental -> `PERMISSION_DENIED`.
9. **Payload 9 (Shadow Ghost Field Injection)**: Cliente injetando campo extra `isAdmin: true` em `/cycles/2026-11/readings/2026-11_gas_T01_A303` -> `PERMISSION_DENIED` (bloqueado por `hasOnly`).
10. **Payload 10 (Oversized Photo Bomb > 380KB)**: Cliente enviando `photo1DataUrl` com 600.000 bytes -> `PERMISSION_DENIED`.
11. **Payload 11 (Path ID Poisoning)**: Documento com ID contendo caracteres inválidos ou > 128 bytes -> `PERMISSION_DENIED`.
12. **Payload 12 (Delete Attempt on Shared Cycle Data)**: Qualquer tentativa de `delete` em `readings`, `references` ou `settings` -> `PERMISSION_DENIED`.
