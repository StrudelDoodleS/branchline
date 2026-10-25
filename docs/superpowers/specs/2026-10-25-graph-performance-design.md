# Graph performance and live placement

The graph should show the current main agent and unfinished subagents on a portrait phone. Finished agents remain in the canonical simulation for Tree, Timeline, details and API-price costs, but must not be drawn, hit-tested or used in fitting/placement of the live graph. Loading history must not briefly lay out every historical agent.

Evidence: the large native session returns 1,047 spawn identities and 1,042 completion states. At 390px / DPR 2.75, the deployed graph issued 80,292 text draws in 2.2 seconds, 79,192 at zero opacity, and occupied about 2.16 CPU seconds. Spawn placement includes completed siblings, per-event callbacks queue obsolete layouts, and the stopped d3 simulation's manual ticks do not dispatch its position-copy listener.

## Approach

Keep the existing graph and repair its data boundary and stopped force layout. A shared graph projection keeps only main/unfinished agents and their visible attachments. Rebuild the force topology once after a consumed event batch, seed a cold layout from the final visible topology, and explicitly copy manual tick positions. Preserve pinned and surviving positions on incremental updates. Cull invisible nodes before drawing. Bound grid work at low zoom and cap coarse-pointer canvas resolution at DPR 2.

Replacing the graph renderer or adding a separate summary graph would expand this repair unnecessarily. Raising frame limits alone leaves historical draws and placement incorrect.

No dependencies, new provider telemetry, changes to usage/pricing, session naming/status rules, or history retention. Existing pan, pinch, selection, Fit, review, switching and pause/visibility behavior must continue to work. Finish with a native large-session check, browser work counts, regression suites and deployment to the existing service under the user's standing push/restart authorization.
