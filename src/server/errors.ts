import { Schema } from "effect"

export class GitHubError extends Schema.TaggedError<GitHubError>()("GitHubError", {
  message: Schema.String,
}) {}

export class ViewError extends Schema.TaggedError<ViewError>()("ViewError", {
  message: Schema.String,
}) {}
