/**
 * Service logic for Article model
 */
const { ArticleModel } = require('./article.model');

class ArticleService {
    
    constructor() {
        this.articleModel = ArticleModel;
    }

    /**
     * Returns list of articles
     */
    async getArticles() {
        return await this.articleModel.find({});
    }

    /**
     * Create a new article
     * @param {*} articleData
     * @param {*} session
     */
    async createArticle(articleData, session) {
        let article = new this.articleModel(articleData);
        return await article.save({session: session});
    }
}

module.exports = {
    ArticleService
};
