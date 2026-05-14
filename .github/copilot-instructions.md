# Copilot Coding Instructions

These instructions define the coding style and conventions to follow when generating or modifying code in this project.

---

## Naming Conventions

- Variables and functions use camelCase: `totalPrice`, `fetchUserData`
- Classes and React components use PascalCase: `UserCard`, `PaymentService`
- Constants use UPPER_SNAKE_CASE: `MAX_RETRY_COUNT`, `API_BASE_URL`
- Boolean variables and props are prefixed with `is`, `has`, or `can`: `isLoading`, `hasError`, `canEdit`
- Database table and column names use snake_case: `user_accounts`, `created_at`
- Names must describe what a variable holds or what a function does. Single-letter names, abbreviations, or generic names like `data`, `item`, `temp`, `val` are not acceptable unless the scope is trivially small (e.g. a `.map(x => x.id)` callback)

---

## Comments

- Do not add comments to code that clearly reads on its own. If the code is self-explanatory, no comment is needed
- Only write comments when explaining non-obvious business logic, algorithms, or decisions that cannot be expressed through naming alone
- `TODO:` and `FIXME:` markers are acceptable for flagging known gaps or issues
- Never add block comments summarizing what a function does when the function name already says it
- Do not add section divider comments like `// --- helpers ---` or `// fetch data` just to annotate a block of code

---

## Function Design

- Functions should do one thing and have a name that clearly expresses what that thing is
- Prefer short functions. If a function grows long because of complexity, that is acceptable — but look for natural split points where a sub-task has a clear name
- A function's arguments and return type should be easy to find without jumping across multiple files
- Avoid scattering the input/output contract of a single function across many type definition files
- Do not define functions inside other functions unless closure access is strictly required. Prefer module-level functions that receive their dependencies as parameters

---

## Avoiding Nested Loops

Never write a loop inside a loop when a better approach is available. Prefer:

- `.map()`, `.filter()`, `.reduce()`, `.find()` over manual `for` loops
- Extracting the inner loop into a named helper function with a meaningful name
- `Map` or object lookups for O(1) access instead of searching with `.find()` inside an outer loop
- Early returns and guard clauses to flatten nested logic

Choose the approach that fits the context — avoid cargo-culting a pattern just to avoid the `for` keyword.

---

## Code Spacing

Introduce blank lines between logically distinct sections within a function — but do not add blank lines between consecutive variable declarations that belong to the same step. Declarations that are part of the same setup can be grouped tightly together.

Never stack unrelated statements without blank lines. Code should breathe.

---

## Error Handling

- Use `try/catch` with clear, specific error messages that describe what failed and why
- Avoid swallowing errors silently
- Name the caught error `error` and surface it with enough context to debug

---

## TypeScript

- Keep type definitions close to where they are used. Avoid scattering related types across unrelated files
- Avoid oversegmenting: define a function's input/output types in the same file or immediately adjacent to its implementation
- Avoid `any`. Use proper types or `unknown` with narrowing
- Avoid unnecessary type assertions (`as X`) unless there is no alternative

---

## React Components

- Extract complex render logic into clearly named variables or helper functions within the same file — do not create a separate file for a sub-piece of a component unless it is genuinely reusable
- Avoid deep component chains: `ParentComponent → PieceA → SubPieceOfA`. If a reader needs to open many files to understand one component, the abstraction is too deep
- Keep JSX clean. If a section of JSX is complex, assign it to a named variable before the return statement
- One file per feature is acceptable. A file can grow as long as it stays readable and coherent

---

## General Clean Code Rules

- Prefer `const` over `let`. Only use `let` when the variable will be reassigned
- Avoid magic numbers. Assign numeric literals to named constants that explain their meaning: `const MAX_VISIBLE_ITEMS = 5` not just `5`
- Avoid deep ternary nesting. Use `if/else` or early returns instead
- Destructure objects and arrays for cleaner access when more than one property is used
- Do not create an intermediate boolean variable just to use it once in an `if` condition. Inline the condition directly unless it is reused or genuinely complex
- When a return value is a non-obvious expression, assign it to a clearly named variable first and return that variable. Readers should not have to parse a complex expression to understand what is being returned
- Avoid dynamic computed property keys (`[key]: value`) when explicit alternatives are available. Prefer branching with explicit property names over clever one-liners that obscure intent
