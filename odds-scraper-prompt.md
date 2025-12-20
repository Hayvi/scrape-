# Odds Scraper Spring Boot Prompt

```text
You are an expert in Java, Spring Boot, web scraping, and backend architecture.

Goal:
Help me build a local Spring Boot backend that scrapes a sportsbook website and exposes structured JSON with this model:

- Sport → League → Game → Market → Outcome (odds)
- Support both prematch and live (in-play) odds.
- Parse and STORE the data into a relational database (PostgreSQL, MySQL, Supabase/Postgres, etc.).
- Package and RUN the app as a standalone .jar on any VPS.
- Keep the service running 24/7, with periodic scraping/refresh and robust error handling.

Target site:
- Base URL: https://tounesbet.com/

Domain model (POJOs):

- Sport: id, name, List<League>
- League: id, name, List<Game>
- Game: id, homeTeam, awayTeam, startTime (ZonedDateTime/Instant), live (boolean), List<Market>
- Market: key, name, List<Outcome>
- Outcome: label, price (BigDecimal), handicap (BigDecimal, optional)

Tech stack:
- Java 17+
- Spring Boot
- HTTP: WebClient or RestTemplate
- HTML parsing: jsoup (if needed)
- JSON mapping: Jackson
- Persistence: Spring Data JPA (or similar) with PostgreSQL / MySQL / Supabase (Postgres)
- Build: Maven or Gradle (your choice), packaged as a fat/uber jar.

What I want you to do:

1. First ask me to paste:
   - Either: a site, OR
   - Sample JSON responses if the site has internal APIs.

2. From that sample:
   - Identify how sports, leagues, games, markets, and odds are represented.
   - Design DTOs or jsoup parsing logic to extract that data.
   - Map it into my domain model (Sport → League → Game → Market → Outcome).
   - Explain how to detect prematch vs live and set the `live` flag.

3. Database & schema:
   - Design a relational schema (tables/relations) that fits the domain model.
   - Provide:
     - JPA entity classes for Sport, League, Game, Market, Outcome (and any join tables if needed).
     - Spring Data repository interfaces for common queries.
   - Show how to configure the database connection in `application.yml` or `application.properties` for:
     - PostgreSQL or Supabase (Postgres)
     - MySQL (optional, but show how to switch drivers/URLs).
   - Include any necessary migrations or DDL (e.g. Liquibase/Flyway scripts or raw SQL) if helpful.

4. Scraping/fetching & persistence:
   - Implement a client/scraper class that:
     - Fetches HTML/JSON from the site.
     - Parses it (jsoup or DTOs).
   - Implement a service class that:
     - Uses the client/scraper.
     - Maps parsed data to the domain model.
     - Saves or updates data in the database using the repositories.
   - Handle idempotency where possible (e.g. don’t create duplicate games each run).

5. Spring Boot REST API:
   - Implement a REST controller with endpoints like:
     - `GET /api/odds/prematch/{sportKey}`
     - `GET /api/odds/live/{sportKey}`
   - These endpoints should read from the database (not scrape on-demand), returning JSON based on the stored data.

6. 24/7 operation & scheduling:
   - Add a scheduling mechanism (e.g. `@Scheduled`) to:
     - Periodically scrape/update prematch odds (e.g. every X minutes).
     - More frequently refresh live odds (e.g. every Y seconds/minutes).
   - Implement basic retry/backoff and error handling so that:
     - Temporary network failures don’t crash the app.
     - Errors are logged clearly.
   - Explain how to configure logging (e.g. logback) for production-style logs.

7. Packaging & deployment:
   - Provide a sample Maven or Gradle configuration:
     - Including Spring Boot plugin to build a fat/uber jar.
   - Show the command to build and run:
     - e.g. `mvn clean package` and `java -jar target/my-odds-scraper.jar`.
   - Explain how to run this jar 24/7 on a VPS:
     - e.g. using systemd, screen, tmux, or Docker (you can describe one recommended option).

8. Code style:
   - Provide complete, compilable Spring Boot code snippets:
     - Domain classes
     - DTOs / parsing logic
     - Entities and repositories
     - Scraper/client class
     - Service
     - Controller
     - Configuration (WebClient/RestTemplate bean, scheduling, DB config)
     - Build file (pom.xml or build.gradle)
   - Use clear, self-explanatory names and avoid magic strings where possible.

Please guide me step by step and explain how the pieces fit together.
```
