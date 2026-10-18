# Interaction map

| State or transition | Trigger | Visible response | Result and continuity | Keyboard/touch equivalent |
|---|---|---|---|---|
| disconnected | broker/store unavailable | explicit red marker and disconnected copy | no invented activity; recovery action remains available | focus recovery control and activate |
| connect | connect/retry control | status changes when the real connection resolves | topology is populated only from the returned snapshot | Enter/Space on focused control |
| connected | authenticated snapshot | devices, workers, boards, and records render in the two-tier lattice | inspector keeps the current selection or chooses the first real object | Tab through semantic controls |
| select node | click/tap a device, worker, or board | role edge and selection marker move; inspector updates | topology does not reflow around the inspector | Arrow keys move through visible node order; Enter selects |
| filter | type in topology filter | only matching branches remain; empty copy appears when there are no matches | clearing the filter restores the prior lattice | input supports normal text editing and Escape clear where provided |
| collapse branch | collapse control on a device/worker branch | branch contents hide and control label changes | selection remains valid if the selected node is still present | Enter/Space on the control |
| expand large branch | `N more workers · expand` control | hidden worker nodes become visible in the same branch | no fake pagination; all real matching workers are exposed | Enter/Space on the control |
| committed event | real claim/post succeeds | existing SVG path receives a bounded lime pulse | committed record appears in the records surface and event settles | same action is reachable from the existing control |
| refresh | refresh control | latest real snapshot replaces the current one | selection is retained when its ID still exists | Enter/Space |
| cached snapshot | network unavailable with persisted cache | `Offline · cached` state and cached data remain explicit | operator can retry; no connected claim is shown | retry control remains keyboard reachable |
| denied | permission/auth failure | `Denied` state and error detail are visible | operator can recover through the existing auth/retry path | focusable retry or sign-in action |
| empty store | valid connected snapshot with no nodes | intentional empty workspace message | controls remain visible and recoverable | Tab order remains intact |
| reduced motion | `prefers-reduced-motion: reduce` | pulse and transitions become static state changes | all information and action feedback remains available | no motion-specific input required |

## Spatial continuity

The inspector is a destination for information, not a second navigation system. Selecting a node changes the inspector content while the node remains in the same tier. Filtering reduces the field without changing the meaning of the remaining paths. A committed event travels along the same route that was visible before the action, then settles into the record list.
