# Coding standards

The codebase is object-oriented TypeScript. Model behaviour with classes, use inheritance for shared contracts and shared behaviour, and keep state behind access modifiers.

## Classes over closures and free functions

- Every module with behaviour is a class created with `new`. No factory functions that return object literals (`createSyncCore()`, `createPostgresStore()`). The sync core is a `SyncCore` class; adapters, the image pipeline, the write queue and command handlers are classes.
- Free functions are not part of the design. A small pure helper goes on the class it belongs to (a `static` method or a private method).
- Constructor injection for dependencies: `new SyncCore(sevenTv, discord, store)`, `new SevenTvAdapter(imagePipeline, options)`.

## Inheritance

- **Ports are abstract classes**, not interfaces: `abstract class SevenTvPort`, `abstract class DiscordPort`, `abstract class StorePort`. Production adapters and in-memory fakes `extend` them. Behaviour shared by every implementation lives in the base class.
- **Domain entities are a class hierarchy.** An abstract base for anything occupying a Slot, with `ReservedSlot` and `ManagedEmote` extending it. Precedence is behaviour on the entities (for example, whether one can displace another), not lookups in a constant array scattered through the core.
- **Commands are a class hierarchy.** An abstract `Command` with subclasses such as `AddEmoteCommand`, `RemoveEmoteCommand`, `LinkSourceSetCommand`, `UnlinkSourceSetCommand`, `SetTrendingCommand`, `ConfigureLogChannelCommand`. Each implements its own `execute`. Dispatching on a `kind` string with `switch` is not allowed.
- **Errors are a hierarchy.** A `DomainError` base for errors the core turns into feedback (`InvalidLinkError`, `QuotaFullError`, …). Adapter errors extend `Error` subclasses of their own (`RateLimitError`, `MissingPermissionError`).
- Bot slash commands follow the same pattern: an abstract `SlashCommand` base handling admin checks and ephemeral replies, one subclass per command.

## Value objects

Wrap domain values that have rules in small immutable classes: `EmoteName` (sanitising, collision suffixes), `Quota` (static/animated, slot limit per boost level), `ServerQuotas`.

## Encapsulation

- Explicit `private`, `protected` and `public` on every member. Fields are `private readonly` unless they must change.
- Collections are not exposed mutably. Return copies or `ReadonlyArray`, and change state through methods (`state.addManagedEmote(...)`).
- `ServerState` is a class with methods, not a bag of arrays the core edits in place. Converting to and from a plain object (`toSnapshot()` / `static fromSnapshot()`) is what the Store port persists.

## Where plain types are fine

Interfaces and type aliases are fine for data that has no behaviour: 7TV API response shapes, database rows, config, snapshots, and the `Change` / feedback records the core returns.

## Tests

Tests still drive the sync core only through its public interface with the in-memory fakes (see spec #2 "Testing Decisions"). The fakes are classes extending the port base classes.
