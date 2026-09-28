# Emergency Pause Access Review and Recovery Runbook

This runbook defines the operational controls for emergency pause access, governance review, and safe recovery for QuickEx production environments.

## Scope

The emergency pause path is a control of last resort. It is separate from normal operator maintenance, deployer setup, and governance action approval. Production environments must preserve a split between:

- Admin: approves governance changes and emergency response coordination.
- Deployer: sets up and publishes the deployed contract instance.
- Operator: runs the service and performs routine maintenance.
- Pauser: is the designated emergency stop holder and is isolated from deploy-time authority.

## Access model

### Required separation

Each environment must ensure:

1. The deployer key is not used for day-to-day operator or pauser actions.
2. The pauser key is not used to approve or execute code upgrades.
3. The admin quorum is not composed only of the same operator identities used for pause activation.
4. The emergency pause path is recorded in the deployment registry alongside the contract ID and signer set.

### Review cadence

- Run a pause-access review at least once per quarter.
- Trigger an ad hoc review immediately after any key rotation, environment migration, or emergency halt.
- Confirm that each pauser remains valid, has dual control, and is approved by the governance owner.

## Activation and approval flow

1. Detect the incident and classify it as a pause-worthy event.
2. Record the reason, affected contract surface, and impacted users.
3. Require a second human approver before the pause is activated.
4. Execute the pause only through the approved emergency control path.
5. Emit the pause event and attach the resulting event id / transaction hash to the incident record.

## Recovery flow

1. Stabilize the incident and confirm the root cause.
2. Verify the deployed contract and registry metadata are still correct.
3. Check that the contract remains in a safe state and that no new writes are active.
4. Review the event catalog to confirm the full pause lifecycle is auditable.
5. Restore service only after the admin and incident lead approve a recovery date and the affected runbooks are updated.
6. Record the recovery result and close the incident with the final state plus any residual risk.

## Recovery checklist

- Contract ID and WASM hash verified
- Event logs reviewed for pause, unpause, and governance transitions
- Registry state confirms the expected deployment
- Operators confirm no pending unsafe writes remain in flight
- Incident owner signs off before re-enabling a live service path

## Escalation

If emergency pause access is missing, misconfigured, or cannot be proven to be separated from admin or deployer roles, the environment must be treated as production-blocking until an owner signs off on the corrective action.
