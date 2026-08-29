# Security and Configuration

Copy `backend/.env.example` to `backend/.env`; never commit secrets or channel
credentials. Use a strong `APP_SECRET` and least-privilege external credentials.
The supported production migration path currently assumes SQLite.
