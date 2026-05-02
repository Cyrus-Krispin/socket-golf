# TODOS

Captured during /plan-eng-review on 2026-05-03.

## Active

### Docker deployment to EC2
- **Why**: The design doc specifies Vercel + Fly.io, but the user plans to deploy the backend to AWS EC2 as a Docker container for full WebSocket server control.
- **What**: Dockerize the Bun + Socket.io server. Set up EC2 instance, Docker registry, deploy script or CI pipeline. Update frontend to point at EC2 URL.
- **Context**: Dockerfile goes in `server/`. Local dev uses `docker-compose` alongside Vite dev server. Production deploys via GitHub Actions or manual.
- **Depends on**: Server implementation complete. Blocked by: nothing.

### CI/CD pipeline
- **Why**: Manual deploys slow down iteration. Push-to-deploy keeps the feedback loop tight.
- **What**: GitHub Actions workflow: build Vite frontend → deploy to Vercel; build Docker image → push to registry → deploy to EC2.
- **Context**: Two deploy targets with different mechanisms. Vercel supports GitHub integration natively. EC2 deployment needs SSH or a container registry + pull.
- **Depends on**: Dockerfile complete. Vercel project configured. EC2 instance running.

### DESIGN.md health check (after MVP ships)
- **Why**: Design systems drift during implementation. Catching it after the first feature ships prevents accumulated visual debt.
- **What**: Compare the shipped UI against DESIGN.md (color palette, fonts, anti-slop rules, Phaser config). Fix any drift. Run `/design-review` for automated visual QA.
- **Context**: After MVP deployment, open the game and verify every color token and font rule against the live site. DESIGN.md is at project root.
- **Depends on**: MVP shipped. Blocked by: nothing.
