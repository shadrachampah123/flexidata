# Techlink GH API contract and test-access request

**Subject:** Request for official Techlink GH test API contract and read-only sandbox access

Hello Techlink GH support,

We are integrating Techlink GH mobile-data fulfilment into FlexiData. We will
not make customer purchases or fund an account while qualifying the integration.
Please provide the official, current **test/sandbox** contract and a test
credential through your approved secure channel. Please do not send secrets in
email or a public ticket.

We need confirmation of the following items:

1. **Environment and authentication**
   - Official test base URL and production base URL, including whether the
     referenced `api.techlinkgh.com` host is correct.
   - Exact authentication mechanism: header/query name, required prefix or
     token exchange, key activation/scope, expiry and IP allow-list rules.
   - A safe read-only credential check, catalogue request, or health endpoint
     that does not create an order. Please explain the expected response for an
     invalid, inactive or wrong-environment key; an earlier unaudited attempt
     returned HTTP 401.
2. **Catalogue and Ghana network identifiers**
   - Official catalogue endpoint and response schema.
   - Exact network/operator identifiers for MTN and Telecel Ghana, if both are
     supported for mobile data.
   - The authoritative bundle/product ID field, denomination/price fields,
     currency, validity and category fields, and whether IDs are stable.
   - A current test catalogue export or representative read-only response. We
     will map every FlexiData plan to an explicit provider ID; we will not derive
     IDs from labels, network names or amounts.
3. **Order submission**
   - Exact HTTP method, path, headers and JSON/body schema.
   - Required recipient format and whether Ghana numbers must include `233`.
   - Provider order/reference fields and the correlation field echoed in later
     lookup responses.
   - Duplicate/custom-reference semantics, idempotency guarantees, rate limits,
     timeout behavior and whether an accepted order can be safely looked up
     after a client timeout.
4. **Authoritative status and finality**
   - Exact lookup method/path and required identifiers.
   - Complete documented status vocabulary and terminal-state rules, including
     accepted, queued, pending, delivered/successful, failed, reversed and
     unknown/inconsistent responses.
   - The exact evidence that confirms delivery and the rules for delayed,
     duplicate, mismatched or malformed responses.
   - Whether a rejected order is definitive and whether any reversal/refund
     notification can arrive after acceptance.
5. **Callbacks/webhooks, if supported**
   - Event schema and correlation fields.
   - Signature algorithm, signed bytes, header names, secret provisioning,
     timestamp/nonce window, replay protection and retry behavior.
   - Whether callback authenticity can be verified server-to-server and whether
     lookup remains authoritative over callbacks.
6. **Test operation**
   - Test account/wallet limits, supported networks/products, sandbox reset
     behavior and support escalation contact.
   - Confirmation that catalogue reads and status lookups are safe for
     qualification and do not create or charge orders.

Please identify the document version/date and the support owner who can confirm
these details. Once verified, we can share our non-secret correlation test cases
and complete a mocked contract suite before any sandbox request. Until the
contract and test credential are verified, our integration remains disabled.

Regards,

FlexiData engineering
