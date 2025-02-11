#ifndef GAME_OBJECT
#define GAME_OBJECT

#include <vector>
//#include <glm/glm.hpp>
//#include <glm/gtc/matrix_transform.hpp>
//#include <glm/gtc/type_ptr.hpp>
#include "Component.h"

class GameObject
{
public:
	std::vector<Component> components = std::vector<Component>(4);
	
	float Shape[15] = {
		// positions         // tex coords
		 0.5f, -0.5f, 1.0f,  0.0f, 0.0f,
		-0.5f, -0.5f, 1.0f,  1.0f, 0.0f,
		 0.0f,  0.5f, -1.0f,  0.5f, 1.0f,
	};

	unsigned int VBO, VAO;

	GameObject() {
		components[0] = Component(1);

		glGenVertexArrays(1, &VAO);
		glGenBuffers(1, &VBO);
		glBindVertexArray(VAO);
		glBindBuffer(GL_ARRAY_BUFFER, VBO);
		glBufferData(GL_ARRAY_BUFFER, sizeof(Shape), Shape, GL_STATIC_DRAW);

		// position attribute
		glVertexAttribPointer(0, 3, GL_FLOAT, GL_FALSE, 5 * sizeof(float), (void*)0);
		glEnableVertexAttribArray(0);
		// color attribute
		glVertexAttribPointer(1, 2, GL_FLOAT, GL_FALSE, 5 * sizeof(float), (void*)(3 * sizeof(float)));
		glEnableVertexAttribArray(1);
	}

	void BindVertexArray() {
		glBindVertexArray(VAO);
	}

	~GameObject() {
		glDeleteVertexArrays(1, &VAO);
		glDeleteBuffers(1, &VBO);
	}

	//void Scale(glm::vec3 factor) {
	//	glm::mat4 scale = glm::mat4(1.0f);

	//	scale = glm::scale(scale, factor);

	//	Shape = Shape * scale;
	//}
};

#endif