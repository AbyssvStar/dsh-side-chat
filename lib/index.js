/**
 * Host half of dsh-side-chat.
 *
 * This row exists mostly as a carrier: the browser half of a DSH plugin is only
 * discovered through an enabled Loader row (see `dsh.client` in package.json).
 * Everything the feature does — forking a turn into a right-sidebar chat and
 * carrying a conclusion back — happens in `lib/client.js`.
 *
 * The exception is anything the browser cannot do itself: appending a
 * `sidechat/result` event to the parent log so the model can see it on its next
 * turn. That lands in this file as the feature lands.
 */

/** Plugin name shown by the Loader. */
export const name = 'dsh-side-chat'

/** Services required from the Host context. */
export const inject = []

/**
 * Keep the package loadable while the host side has nothing to register yet.
 * @param _ctx - Host plugin context.
 */
export function apply(_ctx) {}
