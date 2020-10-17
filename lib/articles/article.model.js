/**
 * Article hold published articles. 
 */
const mongoose = require('mongoose');

const ArticleSchema = new mongoose.Schema({
    title: {
        type: String,
        required: true,
    },
    author: {
        type: String,
        default: 'Anonymous'
    },
    body: {
        type: String,
        required: true,
    },
    created: { type: Date, default: Date.now },
}, {autoCreate: true});

const ArticleModel = mongoose.model('Article', ArticleSchema);

module.exports = {
    ArticleModel
};
