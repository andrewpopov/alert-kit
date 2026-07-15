"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AlertDeliveryError = void 0;
/** Never include a destination URL or provider token in this error. */
class AlertDeliveryError extends Error {
    constructor(code, retryable, destinationId, retryAfterMs, message = code) {
        super(message);
        this.code = code;
        this.retryable = retryable;
        this.destinationId = destinationId;
        this.retryAfterMs = retryAfterMs;
        this.name = 'AlertDeliveryError';
    }
}
exports.AlertDeliveryError = AlertDeliveryError;
