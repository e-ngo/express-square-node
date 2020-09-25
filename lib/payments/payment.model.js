/**
 * Payments hold any pending/processed payments from square.
 */
const mongoose = require('mongoose');

const paymentStatusOptions = ['pending', 'approved', 'confirmed', 'completed', 'error'];
const actionTypeOptions = ['ArticleCreation'];

const PaymentSchema = new mongoose.Schema({
    status: {
        // Current status of payment
        type: String,
        enum: paymentStatusOptions,
        required: true,
    },
    actionType: {
        // Type of action
        type: String,
        enum: actionTypeOptions,
        required: true,
    },
    actionData: {
        // Data associated with action
        type: Object,
    },
    paymentId: {
        // Id from external payment references (in this case from Payment Id from Square)
        type: String,
        default: '',
    },
    created: { type: Date, default: Date.now, required: true },
}, {autoCreate: true});

const PaymentModel = mongoose.model('Payment', PaymentSchema);

module.exports = {
    PaymentModel
};